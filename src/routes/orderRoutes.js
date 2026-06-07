
import express from "express";
import mongoose from "mongoose";
import axios from "axios";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import Coupon from "../models/Coupon.js";
import Store from "../models/Store.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import StockTxn from "../models/StockTxn.js";
import Bill from "../models/Bill.js";
import Review from "../models/Review.js";
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
  if (amount < (c.minAmount || c.minOrderValue || 0)) return { discount: 0, finalAmount: amount };

  let discount = 0;
  if (c.type === "PERCENT") discount = (amount * c.value) / 100;
  else if (c.type === "FLAT") discount = c.value;

  if (c.maxDiscount > 0 && discount > c.maxDiscount) {
    discount = c.maxDiscount;
  }
  if (discount > amount) discount = amount;
  discount = Number(discount.toFixed(2));
  return { discount, finalAmount: Number((amount - discount).toFixed(2)), couponId: c._id };
};

const tryCreateShiprocketShipment = async (order) => {
  console.log('=== Trying to create Shiprocket shipment for order:', order._id.toString());
  try {
    if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD || !process.env.SHIPROCKET_PICKUP_PINCODE) {
      console.log("Shiprocket not configured, skipping shipment creation");
      return null;
    }
    let addr = order.shippingAddress || {};
    if (!addr.pincode || !addr.line1) {
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

    if (!addr.pincode) {
      console.log("Customer pincode is missing, skipping Shiprocket shipment");
      return null;
    }
    if (!addr.line1) {
      console.log("Customer address is missing, skipping Shiprocket shipment");
      return null;
    }

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
        selling_price: Number(it.price || 0),
        discount: 0,
        tax: Number(it.gst || 0),
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
      total_discount: Number(order.couponDiscount || 0),
      sub_total: Number(order.totalEstimate || 0),
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
    // Don't throw, just return null so order creation doesn't fail
    return null;
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
  const products = await Product.find({ _id: { $in: ids }, isActive: true }).populate('store');
  if (products.length !== ids.length) return res.status(400).json({ error: "product_not_found" });

  // Apply store percentage markup to product prices inside the products array before totals and stock validation
  for (const p of products) {
    const storePercentage = p.store?.storePercentage || 0;
    p.price = Number((p.price * (1 + storePercentage / 100)).toFixed(2));
    if (p.mrp != null) {
      p.mrp = Number((p.mrp * (1 + storePercentage / 100)).toFixed(2));
    }
    if (p.variants && p.variants.length > 0) {
      for (const v of p.variants) {
        v.price = Number((v.price * (1 + storePercentage / 100)).toFixed(2));
        if (v.mrp != null) {
          v.mrp = Number((v.mrp * (1 + storePercentage / 100)).toFixed(2));
        }
      }
    }
  }

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

  // Get store from first product (assuming all products from same store for now)
  const store = products[0]?.store;

  // Calculate base revenue (originalStorePrice total)
  let baseTotal = 0;
  for (const it of items) {
    const p = products.find(x => x._id.toString() === it.productId);
    const v = it.variantSku ? (p?.variants || []).find(v => v.sku === String(it.variantSku)) : null;
    const basePrice = v ? (v.originalStorePrice || v.price || 0) : (p?.originalStorePrice || p?.price || 0);
    baseTotal += basePrice * it.quantity;
  }

  // Calculate admin cut and store revenue
  const adminCutPercent = store?.adminCutPercentage || 5;
  const storeRevenue = baseTotal * (1 - adminCutPercent / 100);
  const adminRevenue = payableTotal - storeRevenue;

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
    let phoneVal = cust.phone;
    const defaultAddr = (cust.savedAddresses || []).find(a => a.isDefault);
    if (defaultAddr && defaultAddr.phone) {
      phoneVal = defaultAddr.phone;
    }
    let cleanPhone = String(phoneVal || "").replace(/\D/g, "");
    if (cleanPhone.length > 10) cleanPhone = cleanPhone.slice(-10);
    if (cleanPhone.length !== 10) cleanPhone = String(cust.phone || "").replace(/\D/g, "").slice(-10);
    if (cleanPhone.length !== 10) cleanPhone = "9999999999";
    const emailVal = cust.email || "customer@example.com";
    const nameVal = (defaultAddr && defaultAddr.fullName) || cust.name || "Customer";

    const { data } = await cashfree.post("/pg/orders", {
      order_id: `order_${Date.now()}`,
      order_amount: payableTotal,
      order_currency: "INR",
      customer_details: {
        customer_id: `customer_${cust._id.toString()}`,
        customer_name: nameVal,
        customer_email: emailVal,
        customer_phone: cleanPhone
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
    notes: notes || "",
    store: store?._id || null,
    storeRevenue: Number(storeRevenue.toFixed(2)),
    adminRevenue: Number(adminRevenue.toFixed(2))
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
  const { items, paymentMethod, couponCode, deliveryAddress } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });
  if (!["CASHFREE", "COD"].includes(paymentMethod)) return res.status(400).json({ error: "invalid_payment_method" });
  try {
    const cust = await Customer.findById(req.user.id).select("name phone email savedAddresses");
    if (!cust) return res.status(404).json({ error: "customer_not_found" });

    let phoneVal = cust.phone;
    const defaultAddr = (cust.savedAddresses || []).find(a => a.isDefault);
    if (defaultAddr && defaultAddr.phone) {
      phoneVal = defaultAddr.phone;
    }
    let cleanPhone = String(phoneVal || "").replace(/\D/g, "");
    if (cleanPhone.length > 10) {
      cleanPhone = cleanPhone.slice(-10);
    }
    if (cleanPhone.length !== 10) {
      cleanPhone = String(cust.phone || "").replace(/\D/g, "").slice(-10);
    }
    if (cleanPhone.length !== 10) {
      cleanPhone = "9999999999";
    }

    const emailVal = cust.email || "customer@example.com";
    const nameVal = (defaultAddr && defaultAddr.fullName) || cust.name || "Customer";

    const uniqueIds = [...new Set(items.map((x) => x.productId))];
    const products = await Product.find({ _id: { $in: uniqueIds }, isActive: true }).populate('store');
    if (products.length !== uniqueIds.length) return res.status(400).json({ error: "product_not_found" });

    // Apply store percentage markup to product prices
    for (const p of products) {
      const storePercentage = p.store?.storePercentage || 0;
      p.price = Number((p.price * (1 + storePercentage / 100)).toFixed(2));
      if (p.mrp != null) {
        p.mrp = Number((p.mrp * (1 + storePercentage / 100)).toFixed(2));
      }
      if (p.variants && p.variants.length > 0) {
        for (const v of p.variants) {
          v.price = Number((v.price * (1 + storePercentage / 100)).toFixed(2));
          if (v.mrp != null) {
            v.mrp = Number((v.mrp * (1 + storePercentage / 100)).toFixed(2));
          }
        }
      }
    }

    const totals = computeTotals(products, items);
    const minAmount = Number(process.env.MIN_ORDER_AMOUNT || 5000);
    if (totals.total < minAmount) return res.status(400).json({ error: "min_order_not_met", minAmount });

    const { finalAmount: payableProductTotal } = await validateAndApplyCoupon(couponCode, totals.total);

    // Calculate shipping cost
    let shippingCost = 0;
    let codCharge = 0;
    try {
      // Calculate total weight for shipping
      let totalWeightGrams = 0;
      for (const it of items) {
        const p = products.find(x => x._id.toString() === it.productId.toString());
        if (p && p.weight) {
          totalWeightGrams += (p.weight * it.quantity);
        } else {
          totalWeightGrams += 500 * it.quantity; // default 500g per item
        }
      }
      
      const freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);
      const isPrepaidFree = payableProductTotal >= freeDeliveryAbove && paymentMethod === 'CASHFREE';
      const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
      const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
      const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 85);
      const weight = totalWeightGrams > 0 ? totalWeightGrams / 1000 : 0.5;
      const variable = perKg * weight;
      const baseAmt = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
      shippingCost = isPrepaidFree ? 0 : baseAmt;
      if (paymentMethod === "COD") {
        codCharge = Math.min(Math.max(Math.round(payableProductTotal * 0.05), 40), 100);
      }
    } catch (e) {
      console.error("Shipping calculation failed, using default:", e.message);
      const freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);
      const isPrepaidFree = payableProductTotal >= freeDeliveryAbove && paymentMethod === 'CASHFREE';
      shippingCost = isPrepaidFree ? 0 : 85;
      if (paymentMethod === "COD") {
        codCharge = Math.min(Math.max(Math.round(payableProductTotal * 0.05), 40), 100);
      }
    }

    const totalPayable = Number((payableProductTotal + shippingCost + codCharge).toFixed(2));

    const appId = process.env.CASHFREE_APP_ID || "";
    const isSandbox = appId.toUpperCase().startsWith("TEST");
    const cashfreeMode = isSandbox ? "sandbox" : "production";

    if (paymentMethod === "COD") {
      // COD requires 15% advance on total amount (rounded to whole number for payment)
      const advanceAmount = Math.round(totalPayable * 0.15); // Round to whole number
      const codDueAmount = totalPayable - advanceAmount; // Remaining on delivery
      
      if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
        return res.status(500).json({ error: "cashfree_not_configured" });
      }
      
      const { data } = await cashfree.post("/pg/orders", {
        order_id: `cod_prepay_${Date.now()}`,
        order_amount: advanceAmount,
        order_currency: "INR",
        customer_details: {
          customer_id: `customer_${cust._id.toString()}`,
          customer_name: nameVal,
          customer_email: emailVal,
          customer_phone: cleanPhone
        }
      });
      
      return res.json({
        cashfreeOrderId: data.order_id,
        paymentSessionId: data.payment_session_id,
        amount: advanceAmount,
        totalAmount: totalPayable,
        productTotal: payableProductTotal,
        shippingCost,
        codCharge,
        codDueAmount,
        paymentMethod: "COD",
        cashfreeMode
      });
    } else {
      if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
        return res.status(500).json({ error: "cashfree_not_configured" });
      }
      
      const { data } = await cashfree.post("/pg/orders", {
        order_id: `prepay_${Date.now()}`,
        order_amount: totalPayable,
        order_currency: "INR",
        customer_details: {
          customer_id: `customer_${cust._id.toString()}`,
          customer_name: nameVal,
          customer_email: emailVal,
          customer_phone: cleanPhone
        }
      });
      
      return res.json({
        cashfreeOrderId: data.order_id,
        paymentSessionId: data.payment_session_id,
        amount: totalPayable,
        productTotal: payableProductTotal,
        shippingCost,
        paymentMethod: "CASHFREE",
        cashfreeMode
      });
    }
  } catch (e) {
    console.error("Prepare payment failed:", e.response?.data || e.message || e);
    return res.status(500).json({ error: "payment_initiation_failed" });
  }
});

// Create Order after payment verification (new flow)
router.post("/create-after-verify", auth, requireRole("customer"), async (req, res) => {
  console.log('=== create-after-verify API called ===');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  
  const { cashfreeOrderId, cashfreePaymentId, cashfreeSignature, items, paymentMethod, notes, couponCode, deliveryAddress, totalAmount, codDueAmount, productTotal, shippingCost, codCharge } = req.body || {};
  if (!["CASHFREE", "COD"].includes(paymentMethod)) return res.status(400).json({ error: "invalid_payment_method" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });

  const exists = await Order.findOne({ cashfreePaymentId: cashfreePaymentId });
  if (exists) return res.status(400).json({ error: "order_already_created" });

  const cust = await Customer.findById(req.user.id).select("name phone email kyc address");
  if (!cust) return res.status(404).json({ error: "customer_not_found" });

  try {
    const uniqueIds = [...new Set(items.map((x) => x.productId))];
    const products = await Product.find({ _id: { $in: uniqueIds }, isActive: true }).populate('store');
    if (products.length !== uniqueIds.length) return res.status(400).json({ error: "product_not_found" });
    
    // Get store from first product (assuming all products from same store for now)
    const store = products[0]?.store;
    
    // Calculate base revenue (originalStorePrice total)
    let baseTotal = 0;
    for (const it of items) {
      const p = products.find(x => x._id.toString() === it.productId);
      const v = it.variantSku ? (p?.variants || []).find(v => v.sku === String(it.variantSku)) : null;
      const basePrice = v ? (v.originalStorePrice || v.price || 0) : (p?.originalStorePrice || p?.price || 0);
      baseTotal += basePrice * it.quantity;
    }

    // Apply store percentage markup to product prices inside the products array before totals and stock validation
    for (const p of products) {
      const storePercentage = p.store?.storePercentage || 0;
      p.price = Number((p.price * (1 + storePercentage / 100)).toFixed(2));
      if (p.mrp != null) {
        p.mrp = Number((p.mrp * (1 + storePercentage / 100)).toFixed(2));
      }
      if (p.variants && p.variants.length > 0) {
        for (const v of p.variants) {
          v.price = Number((v.price * (1 + storePercentage / 100)).toFixed(2));
          if (v.mrp != null) {
            v.mrp = Number((v.mrp * (1 + storePercentage / 100)).toFixed(2));
          }
        }
      }
    }
    
    // Calculate admin cut and store revenue
    const adminCutPercent = store?.adminCutPercentage || 5;
    const storeRevenue = baseTotal * (1 - adminCutPercent / 100);
    
    const totals = computeTotals(products, items);
    const { discount: coupDiscount, finalAmount: payableProductTotal, couponId } = await validateAndApplyCoupon(couponCode, totals.total);
    
    // Use provided totals or calculate
    const finalTotal = totalAmount || payableProductTotal + (shippingCost || 0) + (codCharge || 0);
    const adminRevenue = finalTotal - storeRevenue;
    
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

    // Use provided delivery address or fall back to customer's address
    const shippingAddress = deliveryAddress ? {
      line1: deliveryAddress.addressLine1,
      line2: deliveryAddress.addressLine2 || "",
      city: deliveryAddress.city,
      state: deliveryAddress.state,
      pincode: deliveryAddress.pincode
    } : {
      line1: cust.kyc?.addressLine1 || cust.address || "",
      line2: cust.kyc?.addressLine2 || "",
      city: cust.kyc?.city || "",
      state: cust.kyc?.state || "",
      pincode: cust.kyc?.pincode || ""
    };

    console.log('Creating order with finalTotal:', finalTotal);
    const doc = await Order.create({
      customer: { name: cust.name, phone: cust.phone, email: cust.email || "" },
      shippingAddress,
      items: orderItems,
      totalEstimate: finalTotal,
      productTotal: productTotal || payableProductTotal,
      shippingCost: shippingCost || 0,
      codCharge: codCharge || 0,
      couponCode: couponCode?.toUpperCase() || "",
      couponDiscount: coupDiscount,
      status: "CONFIRMED",
      paymentMethod,
      paymentStatus: "PAID",
      cashfreeOrderId,
      cashfreePaymentId,
      cashfreeSignature,
      codDueAmount: paymentMethod === "COD" ? (codDueAmount || Math.round(finalTotal * 0.85)) : 0,
      notes: notes || "",
      store: store?._id || null,
      storeRevenue: Number(storeRevenue.toFixed(2)),
      adminRevenue: Number(adminRevenue.toFixed(2))
    });
    console.log('Order created successfully! Order ID:', doc._id.toString(), 'Order Number:', doc.orderNumber);

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
        paymentType: paymentMethod,
        existingOrderId: doc._id
      });
    } catch {}

    try {
      const to = cust.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
      const html = renderMail({
        heading: paymentMethod === "COD" ? "Order Confirmed (COD)" : "Payment Confirmed",
        subheading: paymentMethod === "COD" 
          ? "Your COD order has been confirmed. 15% advance received." 
          : "We’ve confirmed your payment and are preparing your shipment.",
        highlight: `Order ID: ${doc.orderNumber}`,
        blocks: [
          { label: "Payment Method", value: paymentMethod },
          { label: "Amount Paid", value: `₹${Number(paymentMethod === "COD" ? Math.round(finalTotal * 0.15 * 100) / 100 : doc.totalEstimate).toLocaleString("en-IN")}` },
          ...(paymentMethod === "COD" ? [{ label: "COD Due Amount", value: `₹${Number(doc.codDueAmount).toLocaleString("en-IN")}` }] : []),
          { label: "Current Status", value: doc.status }
        ]
      });
      if (to) await sendEmail({ to, subject: `Order confirmed - ${process.env.COMPANY_NAME || "SmartOdisha"}`, html });
    } catch {}

    try { await tryCreateShiprocketShipment(doc); } catch {}

    return res.json({ success: true, orderId: doc._id, orderNumber: doc.orderNumber });
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

// Cancel Order with 5% deduction and auto refund
router.post("/:id/cancel", auth, requirePermission("orders"), async (req, res) => {
  const { reason } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "not_found" });
    
    // Check if order can be cancelled
    if (["CANCELLED", "RETURNED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "FULFILLED"].includes(order.status)) {
      return res.status(400).json({ error: "cannot_cancel_shipped_order" });
    }

    // Also check if we have a waybill or shipment created
    if (order.shipping?.waybill || order.shiprocketOrderId || order.shiprocketAwbNumber) {
      return res.status(400).json({ error: "cannot_cancel_shipped_order" });
    }
    
    if (order.paymentStatus !== "PAID" || order.paymentMethod !== "CASHFREE") {
      return res.status(400).json({ error: "cannot_cancel_unpaid_order" });
    }
    
    // Calculate refund amount (95% of total)
    const refundAmount = Math.max(0, Math.round((order.totalEstimate * 0.95) * 100) / 100);
    const deductionAmount = order.totalEstimate - refundAmount;
    
    // Restore stock
    for (const item of order.items) {
      const qty = item.quantity;
      if (item.variantSku) {
        await Product.updateOne(
          { _id: item.product, "variants.sku": item.variantSku },
          { $inc: { "variants.$.stock": qty } }
        );
      } else {
        await Product.updateOne(
          { _id: item.product },
          { $inc: { stock: qty } }
        );
      }
    }
    
    // Update product stock summary
    const productIds = order.items.map(i => i.product.toString());
    for (const id of productIds) {
      const p = await Product.findById(id);
      if (p && p.variants && p.variants.length > 0) {
        const sum = p.variants.filter(v => v.isActive !== false).reduce((s, v) => s + (v.stock || 0), 0);
        p.stock = sum;
        await p.save();
      }
    }
    
    // Update order status and refund details
    order.status = "CANCELLED";
    order.refundAmount = refundAmount;
    order.refundReason = reason || "Cancelled by admin";
    order.refundStatus = "PENDING";
    await order.save();
    
    // Create Cashfree refund
    try {
      const refundPayload = {
        refund_id: `refund_${order._id.toString()}_${Date.now()}`,
        refund_amount: refundAmount,
        refund_note: reason || "Order cancelled by admin",
        refund_speed: "STANDARD" // or "INSTANT"
      };
      
      const { data } = await cashfree.post(
        `/pg/orders/${order.cashfreeOrderId}/refunds`,
        refundPayload
      );
      
      // Update order with refund details from Cashfree
      order.refundId = data.refund_id;
      order.refundStatus = "PENDING"; // Cashfree will send webhook
      await order.save();
      
      // Log audit
      await AuditLog.create({
        actorId: req.user.id,
        actorRole: req.user.role,
        type: "ORDER_CANCEL",
        entityType: "ORDER",
        entityId: order._id.toString(),
        note: `Order cancelled. Refund amount: ₹${refundAmount.toLocaleString()}, Deduction: ₹${deductionAmount.toLocaleString()}`
      });
      
      res.json({
        success: true,
        message: "Order cancelled and refund initiated",
        order,
        refundAmount,
        deductionAmount
      });
    } catch (cashfreeErr) {
      console.error("Cashfree refund failed:", cashfreeErr.response?.data || cashfreeErr.message);
      order.refundStatus = "FAILED";
      await order.save();
      
      return res.status(500).json({
        error: "order_cancelled_but_refund_failed",
        message: "Order has been cancelled, but refund failed. Please initiate refund manually.",
        order
      });
    }
  } catch (e) {
    console.error("Cancel order error:", e);
    res.status(500).json({ error: "cancel_failed", message: e.message });
  }
});

export default router;
