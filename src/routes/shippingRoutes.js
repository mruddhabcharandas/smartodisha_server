import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Store from "../models/Store.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import shiprocket, { checkServiceability, createShiprocketClient } from "../lib/shiprocket.js";
import PDFDocument from "pdfkit";
import axios from "axios";
import { findBestCourier, getStoreShippingConfig, calculateShippingCost } from "../lib/shipping.js";

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

// Helper to find best courier (prioritize Delhivery, then Blue Dart)
const getStoreShiprocketCreds = async (storeId) => {
  if (!storeId || !mongoose.isValidObjectId(storeId)) return {};
  try {
    const store = await Store.findById(storeId).select("shiprocketEmail shiprocketPassword pickupAddress");
    if (store?.shiprocketEmail && store?.shiprocketPassword) {
      return { email: store.shiprocketEmail, password: store.shiprocketPassword, store };
    }
    return { store };
  } catch {
    return {};
  }
};

router.get("/check-pincode", async (req, res) => {
  const pincode = String(req.query.pincode || "").trim();
  const order_amount = Number(req.query.order_amount || 0);
  const storeId = req.query.store_id;
  if (!pincode) return res.status(400).json({ error: "missing_pincode" });
  
  let pickupPincode = process.env.SHIPROCKET_PICKUP_PINCODE || "360001";
  const { email: srEmail, password: srPassword, store } = await getStoreShiprocketCreds(storeId);
  if (store?.pickupAddress?.pincode) {
    pickupPincode = store.pickupAddress.pincode;
  }
  
  try {
    const cacheKey = `chk:${pincode}:${pickupPincode}`;
    const cached = _getCache(cacheKey);
    let codAvailable = order_amount <= 2000;
    let deliveryAvailable = true;
    let eta = 3;
    let rate = 85;
    if (cached && cached.delivery_available) {
      return res.json({
        ...cached,
        cod_available: order_amount <= 2000
      });
    }
    const weightKg = Math.max(0.5, Number(req.query.weight || 0) / 1000 || 0.5);
    const response = await checkServiceability({
      pickup_postcode: pickupPincode,
      delivery_postcode: pincode,
      weight: weightKg,
      cod: false
    }, { email: srEmail, password: srPassword });
    const data = response.data;
    
    // Check if we have multiple courier options
    let selectedCourier = null;
    if (data?.data?.couriers) {
      selectedCourier = findBestCourier(data.data.couriers);
    } else if (Array.isArray(data?.couriers)) {
      selectedCourier = findBestCourier(data.couriers);
    }
    
    // Default to true always!
    deliveryAvailable = true;
    codAvailable = order_amount <= 2000;
    eta = selectedCourier?.eta || data?.eta || 3;
    rate = selectedCourier?.rate || data?.rate || 85;
    
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
      rate: rate,
      selected_courier: selectedCourier?.name || 'Delhivery'
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
      cod_available: order_amount <= 2000,
      eta: 3,
      etaStart: add(now, 3).toISOString(),
      etaEnd: add(now, 5).toISOString(),
      rate: 85,
      selected_courier: 'Delhivery'
    });
  }
});

router.post("/calculate", async (req, res) => {
  const storeId = req.body.store_id;
  const { origin, srEmail, srPassword } = await getStoreShippingConfig(storeId);

  const dest = String(req.body?.destination_pin || "").trim();
  const weightGrams = Number(req.body?.weight || 0);
  const order_amount = Number(req.body?.order_amount || 0);
  const payment_method = String(req.body?.payment_method || "prepaid").toLowerCase();
  const paymentMethod = payment_method === "cod" ? "COD" : "CASHFREE";
  
  if (!origin || !dest) return res.status(400).json({ error: "missing_pins" });
  
  try {
    const shippingInfo = await calculateShippingCost({
      origin,
      dest,
      totalWeightGrams: weightGrams,
      orderAmount: order_amount,
      paymentMethod,
      srEmail,
      srPassword
    });

    const freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);

    res.json({
      origin,
      destination: dest,
      weight: shippingInfo.weight,
      order_amount,
      payment_method,
      amount: shippingInfo.baseAmt,
      discount: shippingInfo.isFreeDelivery ? shippingInfo.baseAmt : 0,
      final: shippingInfo.finalCharge,
      label: shippingInfo.finalCharge === 0 && payment_method === 'prepaid' ? "FREE DELIVERY" : `₹${shippingInfo.finalCharge} Delivery`,
      delivery_charge: shippingInfo.deliveryCharge,
      final_charge: shippingInfo.finalCharge,
      free_delivery_above: freeDeliveryAbove,
      cod_available: shippingInfo.codAvailable,
      cod_charge: shippingInfo.codCharge,
      selected_courier: shippingInfo.selectedCourier
    });
  } catch {
    const fallbackShippingInfo = await calculateShippingCost({
      origin,
      dest: null,
      totalWeightGrams: weightGrams,
      orderAmount: order_amount,
      paymentMethod,
      srEmail,
      srPassword
    });

    const freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);

    res.json({
      origin,
      destination: dest,
      weight: fallbackShippingInfo.weight,
      order_amount,
      payment_method,
      amount: fallbackShippingInfo.baseAmt,
      discount: fallbackShippingInfo.isFreeDelivery ? fallbackShippingInfo.baseAmt : 0,
      final: fallbackShippingInfo.finalCharge,
      label: fallbackShippingInfo.finalCharge === 0 && payment_method === 'prepaid' ? "FREE DELIVERY" : `₹${fallbackShippingInfo.finalCharge} Delivery`,
      delivery_charge: fallbackShippingInfo.deliveryCharge,
      final_charge: fallbackShippingInfo.finalCharge,
      free_delivery_above: freeDeliveryAbove,
      cod_available: fallbackShippingInfo.codAvailable,
      cod_charge: fallbackShippingInfo.codCharge,
      selected_courier: fallbackShippingInfo.selectedCourier
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
    const response = await shiprocket.get("/courier/serviceability", {
      params: {
        pickup_postcode: origin,
        delivery_postcode: dest,
        weight: 0.5,
        cod: 0
      }
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
    let pickupPhone = process.env.SHIPROCKET_PICKUP_PHONE || "";
    
    if (mainStoreId && mongoose.isValidObjectId(mainStoreId)) {
      store = await Store.findById(mainStoreId);
      if (store) {
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
    
    // First check serviceability to get best courier
    let selectedCourierId = null;
    try {
      const serviceability = await client.get("/courier/serviceability", {
        params: {
          pickup_postcode: pickupAddress.pincode,
          delivery_postcode: addr.pincode,
          weight: weightKg,
          cod: 0
        }
      });
      
      if (serviceability.data?.data?.couriers || Array.isArray(serviceability.data?.couriers)) {
        const selectedCourier = findBestCourier(serviceability.data?.data?.couriers || serviceability.data?.couriers);
        if (selectedCourier?.courier_id || selectedCourier?.id) {
          selectedCourierId = selectedCourier.courier_id || selectedCourier.id;
        }
      }
    } catch (e) {
      console.log("Serviceability check for courier selection failed, proceeding without specific courier");
    }

    const shipment = {
      order_id: order._id.toString(),
      order_date: new Date().toISOString().split('T')[0],
      pickup_location: process.env.SHIPROCKET_PICKUP_NAME || "Warehouse",
      billing_customer_name: process.env.COMPANY_NAME || "SmartOdisha",
      billing_last_name: "",
      billing_address: process.env.SHIPROCKET_PICKUP_ADDRESS || pickupAddress.line1,
      billing_address_2: "",
      billing_city: process.env.SHIPROCKET_PICKUP_CITY || pickupAddress.city,
      billing_pincode: process.env.SHIPROCKET_PICKUP_PINCODE || pickupAddress.pincode,
      billing_state: process.env.SHIPROCKET_PICKUP_STATE || pickupAddress.state,
      billing_country: "India",
      billing_email: process.env.COMPANY_EMAIL || process.env.SHIPROCKET_EMAIL || "store@example.com",
      billing_phone: process.env.SHIPROCKET_PICKUP_PHONE || process.env.COMPANY_PHONE || "",
      shipping_is_billing: false,
      shipping_customer_name: order.customer.name,
      shipping_last_name: "",
      shipping_address: addr.line1,
      shipping_address_2: addr.line2,
      shipping_city: addr.city,
      shipping_pincode: addr.pincode,
      shipping_state: addr.state,
      shipping_country: "India",
      shipping_email: order.customer.email || "customer@example.com",
      shipping_phone: cleanPhone,
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
      weight: weightKg,
      // Optional: force our selected courier
      ...(selectedCourierId && { courier_id: selectedCourierId })
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
    order.status = "PACKED";
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

router.get("/shiprocket/label/:awb", auth, requireRole(["admin", "seller"]), async (req, res) => {
  const awb = req.params.awb;
  const order = await Order.findOne({ "shipping.waybill": awb });
  
  if (!order) {
    return res.status(404).json({ error: "order_not_found" });
  }
  
  // Check access if seller
  if (req.user.role === "seller") {
    const store = await Store.findOne({ user: req.user.id });
    if (!store || order.store.toString() !== store._id.toString()) {
      return res.status(403).json({ error: "forbidden" });
    }
  }

  // Get store credentials
  const storeId = order.store;
  let srEmail = process.env.SHIPROCKET_EMAIL;
  let srPassword = process.env.SHIPROCKET_PASSWORD;
  if (storeId) {
    const storeObj = await Store.findById(storeId).select("shiprocketEmail shiprocketPassword");
    if (storeObj?.shiprocketEmail && storeObj?.shiprocketPassword) {
      srEmail = storeObj.shiprocketEmail;
      srPassword = storeObj.shiprocketPassword;
    }
  }

  // Get Shiprocket client
  const client = createShiprocketClient({ email: srEmail, password: srPassword });

  try {
    // Call Shiprocket's generate label API
    const labelResponse = await client.post("/orders/courier/generate/label", {
      awb: [awb]
    });

    // If we get a PDF URL, redirect or stream it!
    if (labelResponse.data?.label_url) {
      // Option 1: Redirect to Shiprocket's URL
      return res.redirect(labelResponse.data.label_url);
    } else if (labelResponse.data?.pdf_data) {
      // Option 2: Stream directly if available as base64 or buffer
      const pdfBuffer = Buffer.from(labelResponse.data.pdf_data, 'base64');
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=label_${awb}.pdf`);
      return res.send(pdfBuffer);
    } else {
      // Fallback if needed
      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({ margin: 24, size: "A6" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=label_${awb}.pdf`);
      doc.pipe(res);
      doc.fontSize(16).text("Shipping Label", { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Waybill: ${awb}`);
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
      doc.end();
    }
  } catch (err) {
    console.error("Shipping label from Shiprocket failed, using fallback:", err.response?.data || err.message);
    // Fallback to custom PDF
    const PDFDocument = (await import("pdfkit")).default;
    const doc = new PDFDocument({ margin: 24, size: "A6" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=label_${awb}.pdf`);
    doc.pipe(res);
    doc.fontSize(16).text("Shipping Label", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Waybill: ${awb}`);
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
    doc.end();
  }
});

// Get tracking info for order
router.get("/track/:orderId", auth, requireRole(["admin", "seller", "customer"]), async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: "order_not_found" });
    }
    // Check access
    if (req.user.role === "seller") {
      const store = await Store.findOne({ user: req.user.id });
      if (!store || order.store.toString() !== store._id.toString()) {
        return res.status(403).json({ error: "forbidden" });
      }
    } else if (req.user.role === "customer") {
      const customer = await Customer.findOne({ user: req.user.id });
      if (!customer || order.customer.phone !== customer.phone) {
        return res.status(403).json({ error: "forbidden" });
      }
    }
    if (!order.shiprocketAwbNumber) {
      return res.json({ tracking: null, order });
    }
    // Get Shiprocket credentials
    const products = await Product.find({ _id: { $in: order.items.map(i => i.product) } });
    const storeId = products[0]?.store;
    let srEmail = process.env.SHIPROCKET_EMAIL;
    let srPassword = process.env.SHIPROCKET_PASSWORD;
    if (storeId) {
      const storeObj = await Store.findById(storeId).select("shiprocketEmail shiprocketPassword");
      if (storeObj?.shiprocketEmail && storeObj?.shiprocketPassword) {
        srEmail = storeObj.shiprocketEmail;
        srPassword = storeObj.shiprocketPassword;
      }
    }
    if (!srEmail || !srPassword) {
      return res.json({ tracking: null, order });
    }
    const client = createShiprocketClient({ email: srEmail, password: srPassword });
    const { data } = await client.get(`/courier/track/awb/${order.shiprocketAwbNumber}`);
    res.json({ tracking: data, order });
  } catch (e) {
    console.error("Track error:", e.response?.data || e.message);
    res.status(500).json({ error: "track_failed" });
  }
});

export default router;
