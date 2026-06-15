import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Store from "../models/Store.js";
import Product from "../models/Product.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import PDFDocument from "pdfkit";
import { getStoreShippingConfig, calculateShippingCost } from "../lib/shipping.js";
import * as delhivery from "../services/delhivery.service.js";

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
  const orderAmount = Number(req.query.order_amount || 0);
  const storeId = req.query.store_id;
  
  if (!pincode) return res.status(400).json({ error: "missing_pincode" });
  
  try {
    const cacheKey = `chk:${pincode}`;
    const cached = _getCache(cacheKey);
    
    if (cached && cached.delivery_available) {
      return res.json({
        ...cached,
        cod_available: orderAmount <= (Number(process.env.COD_MAX_LIMIT || 20000))
      });
    }

    const serviceability = await delhivery.checkServiceability(pincode);
    const codLimit = Number(process.env.COD_MAX_LIMIT || 20000);
    const result = {
      pincode,
      delivery_available: serviceability.delivery_available,
      cod_available: serviceability.cod_available && orderAmount <= codLimit,
      cod_limit: codLimit,
      eta: serviceability.eta || 3,
      etaStart: new Date(Date.now() + (serviceability.eta || 3) * 24 * 60 * 60 * 1000).toISOString(),
      etaEnd: new Date(Date.now() + ((serviceability.eta || 3) + 2) * 24 * 60 * 60 * 1000).toISOString(),
      rate: Number(process.env.DELHIVERY_BASE_RATE || 85),
      selected_courier: 'Delhivery'
    };
    
    _putCache(cacheKey, result, 24 * 60 * 60 * 1000);
    res.json(result);
  } catch (error) {
    console.error("Delhivery serviceability check failed:", error);
    const now = new Date();
    const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    const codLimit = Number(process.env.COD_MAX_LIMIT || 20000);
    res.status(200).json({
      pincode,
      delivery_available: false,
      cod_available: false,
      cod_limit: codLimit,
      eta: 3,
      etaStart: addDays(now, 3).toISOString(),
      etaEnd: addDays(now, 5).toISOString(),
      rate: Number(process.env.SHIPPING_BASE_CHARGE || 85),
      selected_courier: 'Delhivery'
    });
  }
});

router.post("/calculate", async (req, res) => {
  const storeId = req.body.store_id;
  const { origin } = await getStoreShippingConfig(storeId);

  const dest = String(req.body?.destination_pin || "").trim();
  const weightGrams = Number(req.body?.weight || 0);
  const orderAmount = Number(req.body?.order_amount || 0);
  const paymentMethod = String(req.body?.payment_method || "prepaid").toLowerCase();
  const pm = paymentMethod === "cod" ? "COD" : "CASHFREE";
  const products = req.body.products || [];

  try {
    const shippingInfo = await calculateShippingCost({
      origin,
      dest,
      totalWeightGrams: weightGrams,
      orderAmount,
      paymentMethod: pm,
      products
    });

    res.json({
      origin,
      destination: dest,
      weight: shippingInfo.weight,
      order_amount: orderAmount,
      payment_method: paymentMethod,
      amount: shippingInfo.baseAmt,
      discount: shippingInfo.isFreeDelivery ? shippingInfo.baseAmt : 0,
      final: shippingInfo.finalCharge,
      label: shippingInfo.finalCharge === 0 && paymentMethod === 'prepaid' ? "FREE DELIVERY" : `₹${shippingInfo.finalCharge} Delivery`,
      delivery_charge: shippingInfo.deliveryCharge,
      final_charge: shippingInfo.finalCharge,
      free_delivery_above: Number(process.env.FREE_DELIVERY_ABOVE || 999),
      cod_available: shippingInfo.codAvailable,
      cod_charge: shippingInfo.codCharge,
      selected_courier: shippingInfo.selectedCourier
    });
  } catch (error) {
    console.error("Shipping calculation failed:", error);
    const fallbackShippingInfo = await calculateShippingCost({
      origin,
      dest: null,
      totalWeightGrams: weightGrams,
      orderAmount,
      paymentMethod: pm,
      products
    });

    res.json({
      origin,
      destination: dest,
      weight: fallbackShippingInfo.weight,
      order_amount: orderAmount,
      payment_method: paymentMethod,
      amount: fallbackShippingInfo.baseAmt,
      discount: fallbackShippingInfo.isFreeDelivery ? fallbackShippingInfo.baseAmt : 0,
      final: fallbackShippingInfo.finalCharge,
      label: fallbackShippingInfo.finalCharge === 0 && paymentMethod === 'prepaid' ? "FREE DELIVERY" : `₹${fallbackShippingInfo.finalCharge} Delivery`,
      delivery_charge: fallbackShippingInfo.deliveryCharge,
      final_charge: fallbackShippingInfo.finalCharge,
      free_delivery_above: Number(process.env.FREE_DELIVERY_ABOVE || 999),
      cod_available: fallbackShippingInfo.codAvailable,
      cod_charge: fallbackShippingInfo.codCharge,
      selected_courier: fallbackShippingInfo.selectedCourier
    });
  }
});

router.get("/eta", async (req, res) => {
  const storeId = req.query.store_id;
  let origin = String(req.query.origin || process.env.DELHIVERY_PICKUP_PINCODE || process.env.SHIPROCKET_PICKUP_PINCODE || "360001").trim();
  
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
    const serviceability = await delhivery.checkServiceability(dest);
    const now = new Date();
    const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    return res.json({ 
      origin, 
      dest, 
      etaStart: addDays(now, serviceability.eta || 3).toISOString(), 
      etaEnd: addDays(now, (serviceability.eta || 3) + 3).toISOString() 
    });
  } catch {
    const now = new Date();
    const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
    return res.json({ origin, dest, etaStart: addDays(now, 3).toISOString(), etaEnd: addDays(now, 6).toISOString() });
  }
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

// Delhivery specific endpoints for admin
router.post("/delhivery/create", auth, requirePermission("orders"), async (req, res) => {
  const { orderId } = req.body || {};
  if (!mongoose.isValidObjectId(orderId)) return res.status(400).json({ error: "invalid_id" });
  
  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ error: "not_found" });
  
  try {
    const productIds = (order.items || []).map(it => it.product);
    const products = await Product.find({ _id: { $in: productIds } });
    const storeIds = [...new Set(products.map(p => p.store?.toString()).filter(Boolean))];
    const mainStoreId = storeIds[0];
    
    let pickupAddress = {
      name: process.env.DELHIVERY_PICKUP_NAME || process.env.SHIPROCKET_PICKUP_NAME || "Warehouse",
      address: process.env.DELHIVERY_PICKUP_ADDRESS || process.env.SHIPROCKET_PICKUP_ADDRESS || "",
      city: process.env.DELHIVERY_PICKUP_CITY || process.env.SHIPROCKET_PICKUP_CITY || "",
      state: process.env.DELHIVERY_PICKUP_STATE || process.env.SHIPROCKET_PICKUP_STATE || "",
      pincode: process.env.DELHIVERY_PICKUP_PINCODE || process.env.SHIPROCKET_PICKUP_PINCODE || "360001",
      phone: process.env.DELHIVERY_PICKUP_PHONE || process.env.SHIPROCKET_PICKUP_PHONE || ""
    };
    
    if (mainStoreId && mongoose.isValidObjectId(mainStoreId)) {
      const store = await Store.findById(mainStoreId);
      if (store) {
        if (store.pickupAddress) {
          pickupAddress = {
            name: store.pickupName || store.name,
            address: `${store.pickupAddress.line1 || ''} ${store.pickupAddress.line2 || ''}`.trim(),
            city: store.pickupAddress.city || '',
            state: store.pickupAddress.state || '',
            pincode: store.pickupAddress.pincode || '',
            phone: store.pickupPhone || store.phone
          };
        }
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
    const orderItems = (order.items || []).map(it => {
      const p = products.find(prod => prod._id.toString() === it.product.toString());
      if (p && p.weight) {
        totalWeightGrams += (p.weight * it.quantity);
      }
      return {
        name: it.name,
        sku: it.variantSku || p?.sku || it.product.toString(),
        units: it.quantity,
        selling_price: it.price,
        discount: 0,
        tax: it.gst || 0,
        hsn: p?.hsnCode || "9999"
      };
    });

    const weightKg = totalWeightGrams > 0 ? (totalWeightGrams / 1000) : 0.5;
    const cleanPhone = String(order.customer.phone || "").replace(/\D/g, "").slice(-10);

    // Create Delhivery shipment
    const shipmentData = {
      format: "json",
      data: {
        shipments: [
          {
            add: addr.line1,
            address2: addr.line2 || '',
            city: addr.city,
            country: "India",
            name: order.customer.name,
            phone: cleanPhone,
            pin: addr.pincode,
            state: addr.state,
            order: order._id.toString(),
            payment_mode: order.paymentMethod === 'COD' ? 'COD' : 'Prepaid',
            shipping_mode: 'Surface',
            return_name: pickupAddress.name,
            return_address: pickupAddress.address,
            return_city: pickupAddress.city,
            return_pin: pickupAddress.pincode,
            return_state: pickupAddress.state,
            return_phone: pickupAddress.phone,
            products_desc: orderItems.map(i => i.name).join(', '),
            order_date: new Date().toISOString().split('T')[0],
            total_amount: order.totalEstimate,
            seller_name: pickupAddress.name,
            seller_add: pickupAddress.address,
            seller_city: pickupAddress.city,
            seller_pin: pickupAddress.pincode,
            seller_state: pickupAddress.state,
            seller_phone: pickupAddress.phone,
            seller_gst_tin: process.env.COMPANY_GST || '',
            ewaybill_no: '',
            ewaybill_date: '',
            ewaybill_validity: '',
            ewaybill_value: 0,
            products: orderItems.map(item => ({
              name: item.name,
              sku: item.sku,
              qty: item.units,
              selling_price: item.selling_price,
              discount: item.discount,
              tax: item.tax,
              hsn: item.hsn
            }))
          }
        ]
      }
    };

    const result = await delhivery.createShipment(shipmentData);
    
    const waybill = result?.packages?.[0]?.waybill || '';
    const trackingUrl = `https://www.delhivery.com/track/package/${waybill}`;
    const status = 'Created';

    order.shipping = { provider: 'Delhivery', waybill, status, trackingUrl };
    order.delhiveryWaybill = waybill;
    order.shipment_status = status;
    order.shippingAddress = addr;
    order.status = 'PACKED';
    await order.save();

    res.json({ waybill, trackingUrl, status });
  } catch (error) {
    console.error("Delhivery shipment creation failed:", error);
    res.status(502).json({ error: "shipment_creation_failed" });
  }
});

router.get("/delhivery/track/:waybill", async (req, res) => {
  const waybill = req.params.waybill;
  try {
    const result = await delhivery.trackShipment(waybill);
    res.json(result);
  } catch {
    res.json({ waybill, status: "In Transit", last_update: new Date().toISOString() });
  }
});

router.get("/delhivery/label/:waybill", auth, requireRole(["admin", "seller"]), async (req, res) => {
  const waybill = req.params.waybill;
  const order = await Order.findOne({ "shipping.waybill": waybill });
  
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

  try {
    const labelData = await delhivery.generateLabel(waybill);
    if (labelData?.success) {
      // If we get a PDF URL, stream it
      const pdfUrl = labelData?.pdf_url;
      if (pdfUrl) {
        const fetch = (await import('node-fetch')).default;
        const pdfRes = await fetch(pdfUrl);
        const pdfBuffer = await pdfRes.buffer();
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename=label_${waybill}.pdf`);
        return res.send(pdfBuffer);
      }
    }
    
    // Fallback to custom PDF
    generateFallbackLabel(res, order, waybill);
  } catch (error) {
    console.error("Delhivery label generation failed:", error);
    generateFallbackLabel(res, order, waybill);
  }
});

function generateFallbackLabel(res, order, waybill) {
  const doc = new PDFDocument({ margin: 24, size: "A6" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=label_${waybill}.pdf`);
  doc.pipe(res);
  
  doc.fontSize(16).text("Shipping Label", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Waybill: ${waybill}`);
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Name: ${order.customer?.name || ""}`);
  doc.fontSize(10).text(`Phone: ${order.customer?.phone || ""}`);
  const addr = order.shippingAddress || {};
  const line1 = [addr.line1, addr.line2].filter(Boolean).join(", ");
  doc.moveDown(0.5);
  doc.fontSize(10).text(line1);
  doc.fontSize(10).text(`${addr.city || ""}, ${addr.state || ""} - ${addr.pincode || ""}`);
  doc.moveDown(0.5);
  doc.fontSize(10).text(`Items: ${order.items?.length || 0}`);
  doc.fontSize(12).text(`Amount: ₹${Number(order.totalEstimate || 0).toLocaleString("en-IN")}`);
  doc.end();
}

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
      const Customer = (await import("../models/Customer.js")).default;
      const customer = await Customer.findOne({ user: req.user.id });
      if (!customer || order.customer.phone !== customer.phone) {
        return res.status(403).json({ error: "forbidden" });
      }
    }
    const waybill = order.delhiveryWaybill || order.shipping?.waybill;
    if (!waybill) {
      return res.json({ tracking: null, order });
    }
    const trackingData = await delhivery.trackShipment(waybill);
    res.json({ tracking: trackingData, order });
  } catch (e) {
    console.error("Track error:", e);
    res.status(500).json({ error: "track_failed" });
  }
});

export default router;
