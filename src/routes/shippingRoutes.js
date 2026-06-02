
import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import shiprocket from "../lib/shiprocket.js";
import PDFDocument from "pdfkit";

const router = express.Router();

const sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");
const _cache = new Map();
const _now = () => Date.now();
const _putCache = (key, data, ttlMs) => _cache.set(key, { data, expires: _now() + ttlMs });
const _getCache = (key) => {
  const it = _cache.get(key);
  if (!it) return null;
  if (_now() > it.expires) { _cache.delete(key); return null; }
  return it.data;
};

router.get("/check-pincode", async (req, res) => {
  const pincode = String(req.query.pincode || "").trim();
  if (!pincode) return res.status(400).json({ error: "missing_pincode" });
  try {
    const cacheKey = `chk:${pincode}`;
    const cached = _getCache(cacheKey);
    if (cached) return res.json(cached);
    const response = await shiprocket.post("/courier/serviceability", {
      pickup_postcode: process.env.SHIPROCKET_PICKUP_PINCODE || "360001",
      delivery_postcode: pincode,
      weight: 0.5,
      cod: 0
    });
    const data = response.data;
    const now = new Date();
    const add = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    const etaStart = add(now, data?.eta || 3).toISOString();
    const etaEnd = add(now, (data?.eta || 3) + 3).toISOString();
    const result = {
      pincode,
      delivery_available: !!data?.available,
      cod_available: !!data?.cod,
      etaStart,
      etaEnd
    };
    _putCache(cacheKey, result, 24 * 60 * 60 * 1000);
    res.json(result);
  } catch (e) {
    console.error("Shiprocket serviceability failed:", e.response?.data || e.message);
    const now = new Date();
    const add = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    res.status(200).json({
      pincode,
      delivery_available: true,
      cod_available: false,
      etaStart: add(now, 3).toISOString(),
      etaEnd: add(now, 6).toISOString()
    });
  }
});

router.post("/calculate", async (req, res) => {
  const origin = String(req.body?.source_pin || process.env.SHIPROCKET_PICKUP_PINCODE || "360001").trim();
  const dest = String(req.body?.destination_pin || "").trim();
  const weight = Number(req.body?.weight || 0);
  const order_amount = Number(req.body?.order_amount || 0);
  if (!origin || !dest) return res.status(400).json({ error: "missing_pins" });
  try {
    const response = await shiprocket.post("/courier/serviceability", {
      pickup_postcode: origin,
      delivery_postcode: dest,
      weight: weight || 0.5,
      cod: 0
    });
    const data = response.data;
    const amt = Number(data?.rate || process.env.SHIPPING_BASE_CHARGE || 85);
    const discount = amt;
    const final = 0;
    res.json({
      origin,
      destination: dest,
      weight,
      amount: amt,
      discount,
      final,
      label: "FREE DELIVERY",
      delivery_charge: amt,
      final_charge: final
    });
  } catch {
    const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
    const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
    const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 85);
    const variable = perKg * (weight || 0.5);
    const amt = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
    const discount = amt;
    const final = 0;
    res.json({
      origin,
      destination: dest,
      weight,
      amount: amt,
      discount,
      final,
      label: "FREE DELIVERY",
      delivery_charge: amt,
      final_charge: final
    });
  }
});

router.get("/eta", async (req, res) => {
  const origin = String(req.query.origin || process.env.SHIPROCKET_PICKUP_PINCODE || "360001").trim();
  const dest = String(req.query.dest || "").trim();
  if (!dest) return res.status(400).json({ error: "missing_params" });
  try {
    const response = await shiprocket.post("/courier/serviceability", {
      pickup_postcode: origin,
      delivery_postcode: dest,
      weight: 0.5,
      cod: 0
    });
    const data = response.data;
    const now = new Date();
    const add = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    const etaStart = add(now, data?.eta || 3).toISOString();
    const etaEnd = add(now, (data?.eta || 3) + 3).toISOString();
    return res.json({ origin, dest, etaStart, etaEnd });
  } catch {}
  const now = new Date();
  const add = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
  return res.json({ origin, dest, etaStart: add(now, 3).toISOString(), etaEnd: add(now, 6).toISOString() });
});

router.post("/estimate", async (req, res) => {
  const { origin, destination, weight } = req.body || {};
  const w = Math.max(0, Number(weight || 0.5));
  const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
  const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
  const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 85);
  const variable = perKg * w;
  const total = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
  res.json({
    origin: String(origin || ""),
    destination: String(destination || ""),
    weight: w,
    breakdown: { base, perKg, variable, minCharge },
    total
  });
});

// Shiprocket specific endpoints for admin
router.post("/shiprocket/create", auth, requirePermission("orders"), async (req, res) => {
  const { orderId } = req.body || {};
  if (!mongoose.isValidObjectId(orderId)) return res.status(400).json({ error: "invalid_id" });
  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ error: "not_found" });
  
  try {
    const getShiprocketToken = async () => {
      const response = await shiprocket.post("/auth/login", {
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD
      });
      return response.data.token;
    };

    const token = await getShiprocketToken();
    let addr = order.shippingAddress || {};
    if (!addr.pincode || !addr.line1) {
      const Customer = (await import("../models/Customer.js")).default;
      const cust = await Customer.findOne({ phone: order.customer.phone });
      if (cust && cust.kyc) {
        addr = {
          line1: cust.kyc.addressLine1 || cust.address || "",
          line2: cust.kyc.addressLine2 || "",
          city: cust.kyc.city || "",
          state: cust.kyc.state || "",
          pincode: cust.kyc.pincode || ""
        };
      }
    }

    const Product = (await import("../models/Product.js")).default;
    const productIds = (order.items || []).map(it => it.product);
    const products = await Product.find({ _id: { $in: productIds } });

    let totalWeightGrams = 0;
    let totalQuantity = 0;
    const orderItems = (order.items || []).map(it => {
      const p = products.find(prod => prod._id.toString() === it.product.toString());
      if (p && p.weight) {
        totalWeightGrams += (p.weight * it.quantity);
      }
      totalQuantity += it.quantity;
      return {
        name: it.name,
        sku: it.variantSku || p?.sku || it.product.toString(),
        units: it.quantity,
        selling_price: it.price,
        discount: 0,
        tax: it.gst,
        hsn: p?.hsn || "9999"
      };
    });

    const weightKg = totalWeightGrams > 0 ? (totalWeightGrams / 1000) : 0.5;
    const cleanPhone = String(order.customer.phone || "").replace(/\D/g, "").slice(-10);

    const shipment = {
      order_id: order._id.toString(),
      order_date: new Date().toISOString().split('T')[0],
      pickup_location: process.env.SHIPROCKET_PICKUP_NAME || "Warehouse",
      billing_customer_name: order.customer.name,
      billing_last_name: "",
      billing_address: addr.line1,
      billing_address_2: addr.line2,
      billing_city: addr.city,
      billing_pincode: addr.pincode,
      billing_state: addr.state,
      billing_country: "India",
      billing_email: order.customer.email || "customer@example.com",
      billing_phone: cleanPhone,
      shipping_is_billing: true,
      order_items: orderItems,
      payment_method: "Prepaid",
      shipping_charges: 0,
      giftwrap_charges: 0,
      transaction_charges: 0,
      total_discount: order.couponDiscount,
      sub_total: order.totalEstimate,
      length: 10,
      breadth: 10,
      height: 10,
      weight: weightKg
    };

    const response = await shiprocket.post("/orders/create/adhoc", shipment, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = response.data;
    const waybill = data.awb_code;
    const trackingUrl = `https://shiprocket.co/tracking/${waybill}`;
    const status = data.status || "CREATED";

    order.shipping = { provider: "SHIPROCKET", waybill, status, trackingUrl };
    order.shiprocketOrderId = data.order_id;
    order.shiprocketShipmentId = data.shipment_id;
    order.shiprocketAwbNumber = waybill;
    order.shipment_status = status;
    order.shippingAddress = addr;
    order.status = "SHIPPED";
    await order.save();

    res.json({ waybill, trackingUrl, status });
  } catch (e) {
    console.error("Shiprocket create failed:", e.response?.data || e.message);
    res.status(502).json({ error: "shipment_creation_failed" });
  }
});

router.get("/shiprocket/track/:awb", async (req, res) => {
  const awb = req.params.awb;
  try {
    const response = await shiprocket.get(`/orders/tracking/awb/${awb}`);
    res.json(response.data);
  } catch {
    res.json({ awb, status: "IN_TRANSIT", last_update: new Date().toISOString() });
  }
});

router.get("/shiprocket/label/:awb", auth, requirePermission("orders"), async (req, res) => {
  const awb = req.params.awb;
  const order = await Order.findOne({ "shipping.waybill": awb }).lean();
  const doc = new PDFDocument({ margin: 24, size: "A6" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=label_${awb}.pdf`);
  doc.pipe(res);
  doc.fontSize(16).text("Shipping Label", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Waybill: ${awb}`);
  if (order) {
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Name: ${order.customer?.name || ""}`);
    doc.fontSize(10).text(`Phone: ${order.customer?.phone || ""}`);
    const a = order.shippingAddress || {};
    const line1 = [a.line1, a.line2].filter(Boolean).join(", ");
    doc.moveDown(0.5);
    doc.fontSize(10).text(line1);
    doc.fontSize(10).text(`${a.city || ""}, ${a.state || ""} - ${a.pincode || ""}`);
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Items: ${order.items?.length || 0}`);
    doc.fontSize(12).text(`Amount: ₹${Number(order.totalEstimate || 0).toLocaleString("en-IN")}`);
  }
  doc.end();
});

export default router;
