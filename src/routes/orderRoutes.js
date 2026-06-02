
import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import Coupon from "../models/Coupon.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import { computeTotals } from "../lib/invoice.js";
import cashfree from "../lib/cashfree.js";
import crypto from "crypto";
import { createBillFromData } from "../lib/billing.js";
import { sendEmail, renderMail } from "../lib/mailer.js";
import AuditLog from "../models/AuditLog.js";
import { notifyAdmin } from "../lib/socket.js";
import shiprocket from "../lib/shiprocket.js";

const router = express.Router();

const _sanitize = (s) => String(s || "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\/+$/, "");

const validateAndApplyCoupon = async (code, amount) => {
  if (!code) return { discount: 0, finalAmount: amount };
  const c = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
  if (!c) return { discount: 0, finalAmount: amount };
  const now = new Date();
  if (c.expiryDate && c.expiryDate < now) return { discount: 0, finalAmount: amount };
  if (c.usageLimit > 0 && c.usedCount >= c.usageLimit) return { discount: 0, finalAmount: amount };
  if (amount < (c.minAmount || 0)) return { discount: 0, finalAmount: amount };

  let discount = 0;
  if (c.type === "PERCENT") discount = (amount * c.value) / 100;
  else if (c.type === "FLAT") discount = c.value;

  if (discount > amount) discount = amount;
  discount = Number(discount.toFixed(2));
  return { discount, finalAmount: Number((amount - discount).toFixed(2)), couponId: c._id };
};

const tryCreateShiprocketShipment = async (order) => {
  try {
    if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD || !process.env.SHIPROCKET_PICKUP_PINCODE) {
      throw new Error("Shiprocket not configured");
    }
    let addr = order.shippingAddress || {};
    if (!addr.pincode || !addr.line1) {
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

    if (!addr.pincode) throw new Error("Customer pincode is missing");
    if (!addr.line1) throw new Error("Customer address is missing");

    const productIds = (order.items || []).map(it => it.product);
    const products = await Product.find({ _id: { $in: productIds } });

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

    const { data } = await shiprocket.post("/orders/create/adhoc", shipment);

    console.log("Shiprocket order created:", data);
    const shipmentId = data.shipment_id;
    const awb = data.awb_code;
    const trackingUrl = `https://shiprocket.co/tracking/${awb}`;

    if (awb) {
      order.shipping = { provider: "SHIPROCKET", waybill: awb, status: data.status || "CREATED", trackingUrl };
      order.shiprocketOrderId = data.order_id;
      order.shiprocketShipmentId = shipmentId;
      order.shiprocketAwbNumber = awb;
      order.shipment_status = data.status;
      order.shippingAddress = addr;
      order.status = "SHIPPED";
      await order.save();
      return order;
    }

    return null;
  } catch (err) {
    console.error("Shiprocket Shipment Exception:", err.response?.data || err.message || err);
    throw err;
  }
};

// Create new order
router.post("/", auth, requireRole("customer"), async (req, res) => {
  const { items, notes, paymentMethod, couponCode, cashfreeOrderId, cashfreePaymentId, cashfreeSignature } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  if (paymentMethod !== "CASHFREE") return res.status(400).json({ error: "invalid_payment_method" });

  const cust = await Customer.findById(req.user.id).select("name phone email kyc address");
  if (!cust) return res.status(404).json({ error: "customer_not_found" });

  const ids = items.map((x) => x.productId);
  const products = await Product.find({ _id: { $in: ids }, isActive: true });
  if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });

  for (const it of items) {
    const p = products.find(x => x._id.toString() === it.productId);
    if (!p) return res.status(400).json({ error: "product_not_found" });
    if (p.minOrderQty && Number(p.minOrderQty) > 0 && it.quantity < Number(p.minOrderQty)) {
      return res.status(400).json({ error: `MOQ_not_met:${p.minOrderQty}` });
    }
    if (it.variantSku) {
      const v = (p.variants || []).find(v => v.sku === String(it.variantSku));
      if (!v || (v.stock || 0) < it.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${p.name}` });
      }
    } else if (p.stock < it.quantity) {
      return res.status(400).json({ error: `Insufficient stock for ${p.name}` });
    }
  }

  const totals = computeTotals(products, items);
  const minAmount = Number(process.env.MIN_ORDER_AMOUNT || 5000);
  if (totals.total < minAmount) {
    return res.status(400).json({ error: "min_order_not_met", minAmount });
  }

  const { discount: coupDiscount, finalAmount: payableTotal, couponId } = await validateAndApplyCoupon(couponCode, totals.total);

  const orderItems = totals.items.map((it) => {
    const p = products.find(x => x._id.toString() === it.product.toString());
    const v = it.variantSku ? (p?.variants || []).find(v => v.sku === String(it.variantSku)) : null;
    return {
      product: it.product,
      variantSku: it.variantSku ? String(it.variantSku) : "",
      attributes: v ? (v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes) : undefined,
      name: it.name,
      price: it.price,
      gst: it.gst,
      quantity: it.quantity,
      lineTotal: it.lineTotal,
      image: (v?.images?.[0]?.url || p?.images?.[0]?.url || "")
    };
  });

  let cashfreeOrder = null;
  try {
    const { data } = await cashfree.post("/pg/orders", {
      order_id: `order_${Date.now()}`,
      order_amount: payableTotal,
      order_currency: "INR",
      customer_details: {
        customer_id: `customer_${cust._id.toString()}`,
        customer_name: cust.name,
        customer_email: cust.email || "customer@example.com",
        customer_phone: cust.phone
      }
    });
    cashfreeOrder = data;
  } catch (err) {
    console.error("Cashfree Order Creation Failed:", err.response?.data || err.message);
    return res.status(500).json({ error: "payment_initiation_failed" });
  }

  const doc = await Order.create({
    customer: { name: cust.name, phone: cust.phone, email: cust.email || "" },
    shippingAddress: {
      line1: cust.kyc?.addressLine1 || cust.address || "",
      line2: cust.kyc?.addressLine2 || "",
      city: cust.kyc?.city || "",
      state: cust.kyc?.state || "",
      pincode: cust.kyc?.pincode || ""
    },
    items: orderItems,
    totalEstimate: payableTotal,
    couponCode: couponCode?.toUpperCase() || "",
    couponDiscount: coupDiscount,
    status: "PENDING_PAYMENT",
    paymentMethod: "CASHFREE",
    paymentStatus: "PENDING",
    cashfreeOrderId: cashfreeOrder?.order_id || cashfreeOrderId || "",
    cashfreePaymentId: cashfreePaymentId || "",
    cashfreeSignature: cashfreeSignature || "",
    notes: notes || ""
  });

  if (couponId) {
    await Coupon.findByIdAndUpdate(couponId, { $inc: { usedCount: 1 } });
  }

  for (const it of items) {
    const qty = Number(it.quantity || 0);
    if (it.variantSku) {
      await Product.updateOne(
        { _id: it.productId, "variants.sku": String(it.variantSku) },
        { $inc: { "variants.$.stock": -qty } }
      );
    } else {
      await Product.updateOne(
        { _id: it.productId },
        { $inc: { stock: -qty } }
      );
    }
  }
  for (const id of ids) {
    const p = await Product.findById(id);
    if (p && p.variants && p.variants.length > 0) {
      const sum = p.variants.filter(v => v.isActive !== false).reduce((s, v) => s + (v.stock || 0), 0);
      p.stock = sum;
      await p.save();
    }
  }

  res.status(201).json({
    order: doc,
    cashfreeOrderId: cashfreeOrder?.order_id,
    paymentSessionId: cashfreeOrder?.payment_session_id
  });
});

// Prepare Payment - new flow
router.post("/prepare-payment", auth, requireRole("customer"), async (req, res) => {
  const { items, paymentMethod, couponCode } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  if (paymentMethod !== "CASHFREE") return res.status(400).json({ error: "invalid_payment_method" });
  try {
    if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
      return res.status(500).json({ error: "cashfree_not_configured" });
    }
    const uniqueIds = [...new Set(items.map((x) => x.productId))];
    const products = await Product.find({ _id: { $in: uniqueIds }, isActive: true });
    if (products.length !== uniqueIds.length) return res.status(400).json({ error: "product_not_found" });
    const totals = computeTotals(products, items);
    const minAmount = Number(process.env.MIN_ORDER_AMOUNT || 5000);
    if (totals.total < minAmount) return res.status(400).json({ error: "min_order_not_met", minAmount });

    const { finalAmount: payableTotal } = await validateAndApplyCoupon(couponCode, totals.total);

    const { data } = await cashfree.post("/pg/orders", {
      order_id: `prepay_${Date.now()}`,
      order_amount: payableTotal,
      order_currency: "INR",
      customer_details: {
        customer_id: `customer_${req.user.id}`,
        customer_name: "Customer",
        customer_email: "customer@example.com",
        customer_phone: "9999999999"
      }
    });
    const checksum = crypto.createHash("sha256").update(JSON.stringify({ items, paymentMethod, amount: payableTotal })).digest("hex");
    return res.json({ cashfreeOrderId: data.order_id, paymentSessionId: data.payment_session_id, amount: payableTotal, checksum });
  } catch (e) {
    console.error("Prepare payment failed:", e.response?.data || e.message || e);
    return res.status(500).json({ error: "payment_initiation_failed" });
  }
});

// Create Order after payment verification (new flow)
router.post("/create-after-verify", auth, requireRole("customer"), async (req, res) => {
  const { cashfreeOrderId, cashfreePaymentId, cashfreeSignature, items, paymentMethod, notes, couponCode } = req.body || {};
  if (paymentMethod !== "CASHFREE") return res.status(400).json({ error: "invalid_payment_method" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });

  const exists = await Order.findOne({ cashfreePaymentId: cashfreePaymentId });
  if (exists) return res.status(400).json({ error: "order_already_created" });

  const cust = await Customer.findById(req.user.id).select("name phone email kyc address");
  if (!cust) return res.status(404).json({ error: "customer_not_found" });

  try {
    const uniqueIds = [...new Set(items.map((x) => x.productId))];
    const products = await Product.find({ _id: { $in: uniqueIds }, isActive: true });
    if (products.length !== uniqueIds.length) return res.status(400).json({ error: "product_not_found" });
    
    const totals = computeTotals(products, items);
    const { discount: coupDiscount, finalAmount: payableTotal, couponId } = await validateAndApplyCoupon(couponCode, totals.total);
    
    for (const it of items) {
      const p = products.find(x => x._id.toString() === it.productId);
      if (!p) return res.status(400).json({ error: "product_not_found" });
      const qty = Number(it.quantity || 0);
      if (it.variantSku) {
        const v = (p.variants || []).find(v => v.sku === String(it.variantSku));
        if (!v || (v.stock || 0) < qty) return res.status(400).json({ error: "stock_changed" });
      } else if ((p.stock || 0) < qty) {
        return res.status(400).json({ error: "stock_changed" });
      }
    }

    const orderItems = totals.items.map((it) => {
      const p = products.find(x => x._id.toString() === it.product.toString());
      const v = it.variantSku ? (p?.variants || []).find(v => v.sku === String(it.variantSku)) : null;
      return {
        product: it.product,
        variantSku: it.variantSku ? String(it.variantSku) : "",
        attributes: v ? (v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes) : undefined,
        name: it.name,
        price: it.price,
        gst: it.gst,
        quantity: it.quantity,
        lineTotal: it.lineTotal,
        image: (v?.images?.[0]?.url || p?.images?.[0]?.url || "")
      };
    });

    const doc = await Order.create({
      customer: { name: cust.name, phone: cust.phone, email: cust.email || "" },
      shippingAddress: {
        line1: cust.kyc?.addressLine1 || cust.address || "",
        line2: cust.kyc?.addressLine2 || "",
        city: cust.kyc?.city || "",
        state: cust.kyc?.state || "",
        pincode: cust.kyc?.pincode || ""
      },
      items: orderItems,
      totalEstimate: payableTotal,
      couponCode: couponCode?.toUpperCase() || "",
      couponDiscount: coupDiscount,
      status: "CONFIRMED",
      paymentMethod: "CASHFREE",
      paymentStatus: "PAID",
      cashfreeOrderId,
      cashfreePaymentId,
      cashfreeSignature,
      notes: notes || ""
    });

    if (couponId) {
      await Coupon.findByIdAndUpdate(couponId, { $inc: { usedCount: 1 } });
    }

    for (const it of items) {
      const qty = Number(it.quantity || 0);
      if (it.variantSku) {
        await Product.updateOne(
          { _id: it.productId, "variants.sku": String(it.variantSku) },
          { $inc: { "variants.$.stock": -qty } }
        );
      } else {
        await Product.updateOne(
          { _id: it.productId },
          { $inc: { stock: -qty } }
        );
      }
    }
    for (const id of uniqueIds) {
      const p = await Product.findById(id);
      if (p && p.variants && p.variants.length > 0) {
        const sum = p.variants.filter(v => v.isActive !== false).reduce((s, v) => s + (v.stock || 0), 0);
        p.stock = sum;
        await p.save();
      }
    }

    try {
      await createBillFromData({
        customerData: { phone: doc.customer.phone, name: doc.customer.name, email: doc.customer.email },
        items: doc.items.map(it => ({
          product: it.product,
          variantSku: it.variantSku ? String(it.variantSku) : undefined,
          quantity: it.quantity
        })),
        paymentType: "CASHFREE",
        existingOrderId: doc._id
      });
    } catch {}

    try {
      const to = cust.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
      const html = renderMail({
        heading: "Payment Confirmed",
        subheading: "We’ve confirmed your payment and are preparing your shipment.",
        highlight: `Order ID: ${doc._id}`,
        blocks: [
          { label: "Payment Method", value: "CASHFREE" },
          { label: "Amount Paid", value: `₹${Number(doc.totalEstimate).toLocaleString("en-IN")}` },
          { label: "Current Status", value: doc.status }
        ]
      });
      if (to) await sendEmail({ to, subject: `Payment confirmed - ${process.env.COMPANY_NAME || "SmartOdisha"}`, html });
    } catch {}

    try { await tryCreateShiprocketShipment(doc); } catch {}

    return res.json({ success: true, orderId: doc._id });
  } catch (e) {
    console.error("Create after verify error:", e);
    return res.status(500).json({ error: "order_create_failed" });
  }
});

// Verify Cashfree Payment
router.post("/verify-payment", async (req, res) => {
  const { cashfreeOrderId, cashfreePaymentId, cashfreeSignature, orderId, orderAmount } = req.body || {};

  const signatureData = `${cashfreeOrderId}${orderAmount}`;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.CASHFREE_SECRET_KEY)
    .update(signatureData)
    .digest("base64");

  if (expectedSignature === cashfreeSignature) {
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "order_not_found" });

    try {
      const ids = order.items.map(i => i.product.toString());
      const products = await Product.find({ _id: { $in: ids }, isActive: true });
      for (const it of order.items) {
        const p = products.find(x => x._id.toString() === it.product.toString());
        if (!p) return res.status(400).json({ error: "product_not_found" });
        const qty = Number(it.quantity || 0);
        if (it.variantSku) {
          const v = (p.variants || []).find(v => v.sku === String(it.variantSku));
          if (!v || (v.stock || 0) < qty) return res.status(400).json({ error: "stock_changed" });
        } else if ((p.stock || 0) < qty) {
          return res.status(400).json({ error: "stock_changed" });
        }
      }
    } catch (err) {
      return res.status(400).json({ error: "revalidation_failed" });
    }

    order.paymentStatus = "PAID";
    order.status = "CONFIRMED";
    order.cashfreePaymentId = cashfreePaymentId;
    order.cashfreeSignature = cashfreeSignature;
    await order.save();

    try {
      await createBillFromData({
        customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
        items: order.items.map(it => ({
          product: it.product,
          variantSku: it.variantSku ? String(it.variantSku) : undefined,
          quantity: it.quantity
        })),
        paymentType: "CASHFREE",
        existingOrderId: order._id
      });
    } catch (err) {
      console.error("Auto-billing failed after payment:", err);
    }

    try {
      await AuditLog.create({ actorId: "", actorRole: "system", type: "ORDER_STATUS", entityType: "ORDER", entityId: order._id.toString(), note: "Payment verified (CASHFREE)" });
      const to = order.customer?.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
      const html = renderMail({
        heading: "Payment Confirmed",
        subheading: "We’ve confirmed your payment and are preparing your shipment.",
        highlight: `Order ID: ${order._id}`,
        blocks: [
          { label: "Payment Method", value: "CASHFREE" },
          { label: "Amount Paid", value: `₹${Number(order.totalEstimate).toLocaleString("en-IN")}` },
          { label: "Current Status", value: order.status }
        ]
      });
      if (to) await sendEmail({ to, subject: `Payment confirmed - ${process.env.COMPANY_NAME || "SmartOdisha"}`, html });
    } catch {}

    try {
      if (order.status === "CONFIRMED") {
        const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
        const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
        const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 85);
        const weight = 0.5;
        const variable = perKg * weight;
        const amt = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
        order.shipping_charge = amt;
        order.shipping_discount = amt;
        await order.save();

        const created = await tryCreateShiprocketShipment(order);
        if (!created) {
          order.shipment_status = "CREATION_FAILED";
          await order.save();
        }
      }
    } catch {}

    res.json({ success: true, message: "payment_verified" });
  } else {
    res.status(400).json({ error: "invalid_signature" });
  }
});

router.get("/my-orders", async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "missing_phone" });
  const items = await Order.find({ "customer.phone": phone }).sort({ createdAt: -1 });
  res.json(items);
});

router.get("/my", auth, requireRole("customer"), async (req, res) => {
  const cust = await Customer.findById(req.user.id).select("phone email");
  if (!cust) return res.status(404).json({ error: "not_found" });
  const items = await Order.find({ "customer.phone": cust.phone }).sort({ createdAt: -1 });
  res.json(items);
});

router.get("/", auth, requirePermission("orders"), async (req, res) => {
  const status = req.query.status;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const filter = {};
  if (status) {
    filter.status = status;
  } else {
    filter.status = { $ne: "PENDING_ADMIN_APPROVAL" };
  }
  const items = await Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
  res.json({ page, limit, count: items.length, items });
});

router.get("/:id", auth, requirePermission("orders"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const item = await Order.findById(req.params.id);
  if (!item) return res.status(404).json({ error: "not_found" });
  res.json(item);
});

export default router;
