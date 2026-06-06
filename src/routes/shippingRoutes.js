import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Store from "../models/Store.js";
import Product from "../models/Product.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import shiprocket from "../lib/shiprocket.js";
import PDFDocument from "pdfkit";
import axios from "axios";

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

const getStoreShiprocketClient = async (storeId) => {
  if (!storeId) return shiprocket;
  
  const store = await Store.findById(storeId);
  if (!store || !store.shiprocketEmail || !store.shiprocketPassword) return shiprocket;
  
  try {
    let token = null;
    const cacheKey = `shiprocket_token_${storeId}`;
    if (_cache.has(cacheKey)) {
      const cached = _cache.get(cacheKey);
      if (cached.expires > Date.now()) {
        token = cached.token;
      }
    }
    
    if (!token) {
      const response = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", {
        email: store.shiprocketEmail,
        password: store.shiprocketPassword
      });
      token = response.data.token;
      _cache.set(cacheKey, { token, expires: Date.now() + 7 * 60 * 60 * 1000 });
    }
    
    const client = axios.create({
      baseURL: "https://apiv2.shiprocket.in/v1/external"
    });
    client.interceptors.request.use(async (config) => {
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
    return client;
  } catch (error) {
    console.error("Failed to get store-specific shiprocket client:", error.message);
    return shiprocket;
  }
};

router.get("/check-pincode", async (req, res) => {
  const pincode = String(req.query.pincode || "").trim();
  const order_amount = Number(req.query.order_amount || 0);
  const storeId = req.query.store_id;
  if (!pincode) return res.status(400).json({ error: "missing_pincode" });
  
  let pickupPincode = process.env.SHIPROCKET_PICKUP_PINCODE || "360001";
  
  if (storeId && mongoose.isValidObjectId(storeId)) {
    try {
      const store = await Store.findById(storeId);
      if (store?.pickupAddress?.pincode) {
        pickupPincode = store.pickupAddress.pincode;
      }
    } catch {}
  }
  
  try {
    const cacheKey = `chk:${pincode}:${pickupPincode}`;
    const cached = _getCache(cacheKey);
    let codAvailable = false;
    let deliveryAvailable = true;
    let eta = 3;
    let rate = 85;
    if (cached) {
      codAvailable = !!cached.cod_available && order_amount <= 2000;
      return res.json({
        ...cached,
        cod_available: codAvailable
      });
    }
    const response = await shiprocket.post("/courier/serviceability", {
      pickup_postcode: pickupPincode,
      delivery_postcode: pincode,
      weight: 0.5,
      cod: 0
    });
    const data = response.data;
    deliveryAvailable = !!data?.available;
    codAvailable = !!data?.cod && order_amount <= 2000;
    eta = data?.eta || 3;
    rate = data?.rate || 85;
    const now = new Date();
    const add = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    const etaStart = add(now, eta).toISOString();
    const etaEnd = add(now, eta + 2).toISOString();
    const result = {
      pincode,
      delivery_available: deliveryAvailable,
      cod_available: codAvailable,
      eta: eta,
      etaStart,
      etaEnd,
      rate: rate
    };
    _putCache(cacheKey, { ...result, cod_available: !!data?.cod }, 24 * 60 * 60 * 1000);
    res.json(result);
  } catch (e) {
    console.error("Shiprocket serviceability failed:", e.response?.data || e.message);
    const now = new Date();
    const add = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    res.status(200).json({
      pincode,
      delivery_available: true,
      cod_available: order_amount <= 2000,
      eta: 3,
      etaStart: add(now, 3).toISOString(),
      etaEnd: add(now, 5).toISOString(),
      rate: 85
    });
  }
});

router.post("/calculate", async (req, res) => {
  const storeId = req.body.store_id;
  let origin = String(req.body?.source_pin || process.env.SHIPROCKET_PICKUP_PINCODE || "360001").trim();
  
  if (storeId && mongoose.isValidObjectId(storeId)) {
    try {
      const store = await Store.findById(storeId);
      if (store?.pickupAddress?.pincode) {
        origin = store.pickupAddress.pincode;
      }
    } catch {}
  }
  
  const dest = String(req.body?.destination_pin || "").trim();
  const weight = Number(req.body?.weight || 0);
  const order_amount = Number(req.body?.order_amount || 0);
  const payment_method = String(req.body?.payment_method || "prepaid").toLowerCase();
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
    const freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);
    const isFree = order_amount >= freeDeliveryAbove && payment_method === "prepaid";
    const discount = isFree ? amt : 0;
    let final = isFree ? 0 : amt;
    const codCharge = Math.round((order_amount * 0.15) * 100) / 100;
    if (payment_method === "cod") {
      final = amt + codCharge;
    }
    const codAvailable = !!data?.cod && order_amount <= 2000;
    res.json({
      origin,
      destination: dest,
      weight,
      order_amount,
      payment_method,
      amount: amt,
      discount,
      final,
      label: isFree ? "FREE DELIVERY" : `₹${final} Delivery`,
      delivery_charge: amt,
      final_charge: final,
      free_delivery_above: freeDeliveryAbove,
      cod_available: codAvailable,
      cod_charge: payment_method === "cod" ? codCharge : 0
    });
  } catch {
    const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
    const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
    const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 85);
    const variable = perKg * (weight || 0.5);
    const amt = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
    const freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);
    const isFree = order_amount >= freeDeliveryAbove && payment_method === "prepaid";
    const discount = isFree ? amt : 0;
    let final = isFree ? 0 : amt;
    const codCharge = Math.round((order_amount * 0.15) * 100) / 100;
    if (payment_method === "cod") {
      final = amt + codCharge;
    }
    const codAvailable = order_amount <= 2000;
    res.json({
      origin,
      destination: dest,
      weight,
      order_amount,
      payment_method,
      amount: amt,
      discount,
      final,
      label: isFree ? "FREE DELIVERY" : `₹${final} Delivery`,
      delivery_charge: amt,
      final_charge: final,
      free_delivery_above: freeDeliveryAbove,
      cod_available: codAvailable,
      cod_charge: payment_method === "cod" ? codCharge : 0
    });
  }
});

router.get("/eta", async (req, res) => {
  const storeId = req.query.store_id;
  let origin = String(req.query.origin || process.env.SHIPROCKET_PICKUP_PINCODE || "360001").trim();
  
  if (storeId && mongoose.isValidObjectId(storeId)) {
    try {
      const store = await Store.findById(storeId);
      if (store?.pickupAddress?.pincode) {
        origin = store.pickupAddress.pincode;
      }
    } catch {}
  }
  
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
    const productIds = (order.items || []).map(it => it.product);
    const products = await Product.find({ _id: { $in: productIds } });
    const storeIds = [...new Set(products.map(p => p.store?.toString()).filter(Boolean))];
    const mainStoreId = storeIds[0];
    let store = null;
    let client = shiprocket;
    let pickupLocation = process.env.SHIPROCKET_PICKUP_NAME || "Warehouse";
    let pickupAddress = { line1: "", line2: "", city: "", state: "", pincode: process.env.SHIPROCKET_PICKUP_PINCODE || "360001" };
    let pickupPhone = "";
    
    if (mainStoreId && mongoose.isValidObjectId(mainStoreId)) {
      store = await Store.findById(mainStoreId);
      if (store) {
        client = await getStoreShiprocketClient(mainStoreId);
        if (store.pickupAddress) pickupAddress = store.pickupAddress;
        if (store.pickupName) pickupLocation = store.pickupName;
        if (store.pickupPhone) pickupPhone = store.pickupPhone;
      }
    }
    
    let addr = order.shippingAddress || {};
    if (!addr.pincode || !addr.line1) {
      const Customer = (await import("../models/Customer.js")).default;
      const cust = await Customer.findOne({ phone: order.customer.phone });
      if (cust) {
        if (cust.address) {
          const pincodeMatch = cust.address.match(/\b(\d{6})\b/);
          const cityStateMatch = cust.address.match(/,\s*([^,]+),\s*([^,]+)\s*-\s*\d{6}/);
          addr = {
            line1: cust.address.split(',').slice(0, 2).join(',').trim(),
            line2: '',
            city: cityStateMatch ? cityStateMatch[1].trim() : '',
            state: cityStateMatch ? cityStateMatch[2].trim() : '',
            pincode: pincodeMatch ? pincodeMatch[1] : (cust.kyc?.pincode || '')
          };
        } else if (cust.kyc) {
          addr = {
            line1: cust.kyc.addressLine1 || '',
            line2: cust.kyc.addressLine2 || '',
            city: cust.kyc.city || '',
            state: cust.kyc.state || '',
            pincode: cust.kyc.pincode || ''
          };
        }
      }
    }

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
      pickup_location: pickupLocation,
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

    const response = await client.post("/orders/create/adhoc", shipment);

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
