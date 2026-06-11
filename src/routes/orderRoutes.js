
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
import shiprocket, { checkServiceability, createShiprocketClient } from "../lib/shiprocket.js";

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
    const productIds = (order.items || []).map(it => it.product);
    const products = await Product.find({ _id: { $in: productIds } });
    const storeId = products[0]?.store;
    
    let srEmail = process.env.SHIPROCKET_EMAIL;
    let srPassword = process.env.SHIPROCKET_PASSWORD;
    let pickupPincode = process.env.SHIPROCKET_PICKUP_PINCODE || "360001";
    let pickupLocation = process.env.SHIPROCKET_PICKUP_NAME || "Warehouse";
    
    if (storeId) {
      const storeObj = await Store.findById(storeId).select("shiprocketEmail shiprocketPassword pickupAddress pickupName");
      if (storeObj) {
        if (storeObj.shiprocketEmail && storeObj.shiprocketPassword) {
          srEmail = storeObj.shiprocketEmail;
          srPassword = storeObj.shiprocketPassword;
        }
        if (storeObj.pickupAddress?.pincode) {
          pickupPincode = storeObj.pickupAddress.pincode;
        }
        if (storeObj.pickupName) {
          pickupLocation = storeObj.pickupName;
        }
      }
    }
    
    if (!srEmail || !srPassword) {
      console.log("Shiprocket not configured for store or system, skipping shipment creation");
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

    const client = createShiprocketClient({ email: srEmail, password: srPassword });
    
    // Dynamically resolve pickup location name from Shiprocket account
    try {
      const locationsRes = await client.get("/settings/company/pickup");
      const locations = locationsRes.data?.data?.shipping_address || [];
      if (locations.length > 0) {
        const matchedLoc = locations.find(loc => String(loc.pin_code || loc.pincode || "") === String(pickupPincode));
        if (matchedLoc) {
          pickupLocation = matchedLoc.pickup_location;
        } else {
          pickupLocation = locations[0].pickup_location;
        }
        console.log("Dynamically resolved Shiprocket pickup location nickname for order:", pickupLocation);
      }
    } catch (locErr) {
      console.error("Failed to fetch Shiprocket pickup locations, falling back to:", pickupLocation, locErr.message);
    }

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
      payment_method: order.paymentMethod === "COD" ? "COD" : "Prepaid",
      shipping_charges: Number(order.shippingCost || 0),
      giftwrap_charges: 0,
      transaction_charges: 0,
      total_discount: Number(order.couponDiscount || 0),
      sub_total: Number(order.totalEstimate || 0),
      length: 10,
      breadth: 10,
      height: 10,
      weight: weightKg
    };

    const { data } = await client.post("/orders/create/adhoc", shipment);

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
      // Do not auto-set order status to SHIPPED. Keep it as CONFIRMED so seller can manually manage the fulfillment lifecycle.
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

export const confirmAndFinalizeOrder = async (order, cashfreePaymentId, cashfreeSignature) => {
  if (order.paymentStatus === "PAID") {
    console.log("confirmAndFinalizeOrder: Order already paid:", order._id.toString());
    return order;
  }

  console.log("=== confirmAndFinalizeOrder: Finalizing order ===", order._id.toString());
  order.paymentStatus = "PAID";
  order.status = "CONFIRMED";
  if (cashfreePaymentId) order.cashfreePaymentId = cashfreePaymentId;
  if (cashfreeSignature) order.cashfreeSignature = cashfreeSignature;

  // Decrement Stock
  const uniqueIds = [...new Set(order.items.map(x => x.product.toString()))];
  const products = await Product.find({ _id: { $in: uniqueIds } });

  for (const it of order.items) {
    const qty = Number(it.quantity || 0);
    const p = products.find(x => x._id.toString() === it.product.toString());
    if (p) {
      if (it.variantSku) {
        await Product.updateOne(
          { _id: it.product, "variants.sku": String(it.variantSku) },
          { $inc: { "variants.$.stock": -qty } }
        );
      } else {
        await Product.updateOne(
          { _id: it.product },
          { $inc: { stock: -qty } }
        );
      }
    }
  }

  // Update parent product stocks
  for (const id of uniqueIds) {
    const p = await Product.findById(id);
    if (p && p.variants && p.variants.length > 0) {
      const sum = p.variants.filter(v => v.isActive !== false).reduce((s, v) => s + (v.stock || 0), 0);
      p.stock = sum;
      await p.save();
    }
  }

  // Update Coupon count if applied
  if (order.couponCode) {
    try {
      const coupon = await Coupon.findOne({ code: order.couponCode.toUpperCase() });
      if (coupon) {
        coupon.usedCount = (coupon.usedCount || 0) + 1;
        await coupon.save();
      }
    } catch (err) {
      console.error("Failed to increment coupon count:", err);
    }
  }

  // Create Bill
  try {
    await createBillFromData({
      customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
      items: order.items.map(it => ({
        product: it.product,
        variantSku: it.variantSku ? String(it.variantSku) : undefined,
        quantity: it.quantity
      })),
      paymentType: order.paymentMethod,
      existingOrderId: order._id
    });
  } catch (err) {
    console.error("Billing creation failed on finalize:", err);
  }

  // Send Email
  try {
    const to = order.customer.email || process.env.MAIL_TO || process.env.COMPANY_EMAIL || process.env.MAIL_FROM;
    const html = renderMail({
      heading: order.paymentMethod === "COD" ? "Order Confirmed (COD)" : "Payment Confirmed",
      subheading: order.paymentMethod === "COD" 
        ? "Your COD order has been confirmed. 15% advance received." 
        : "We’ve confirmed your payment and are preparing your shipment.",
      highlight: `Order ID: ${order.orderNumber}`,
      blocks: [
        { label: "Payment Method", value: order.paymentMethod },
        { label: "Amount Paid", value: `₹${Number(order.paymentMethod === "COD" ? Math.ceil(order.totalEstimate * 0.15) : order.totalEstimate).toLocaleString("en-IN")}` },
        ...(order.paymentMethod === "COD" ? [{ label: "COD Due Amount", value: `₹${Number(order.codDueAmount).toLocaleString("en-IN")}` }] : []),
        { label: "Current Status", value: order.status }
      ]
    });
    if (to) await sendEmail({ to, subject: `Order confirmed - ${process.env.COMPANY_NAME || "SmartOdisha"}`, html });
  } catch (err) {
    console.error("Email send failed on finalize:", err);
  }

  // Shiprocket auto creation
  try {
    await tryCreateShiprocketShipment(order);
  } catch (err) {
    console.error("Shiprocket shipment auto-create failed on finalize:", err);
  }

  // Save the finalized order
  await order.save();
  return order;
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

    const { discount: coupDiscount, finalAmount: payableProductTotal } = await validateAndApplyCoupon(couponCode, totals.total);

    // Calculate shipping cost - USING SAME LOGIC AS shippingRoutes /calculate endpoint!
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
      
      const storeId = products[0]?.store?._id || products[0]?.store;
      
      // Let's get store credentials and pickup postcode
      let origin = process.env.SHIPROCKET_PICKUP_PINCODE || "360001";
      let srEmail = process.env.SHIPROCKET_EMAIL;
      let srPassword = process.env.SHIPROCKET_PASSWORD;
      
      if (storeId) {
        const storeObj = await Store.findById(storeId).select("shiprocketEmail shiprocketPassword pickupAddress");
        if (storeObj) {
          if (storeObj.shiprocketEmail && storeObj.shiprocketPassword) {
            srEmail = storeObj.shiprocketEmail;
            srPassword = storeObj.shiprocketPassword;
          }
          if (storeObj.pickupAddress?.pincode) {
            origin = storeObj.pickupAddress.pincode;
          }
        }
      }
      
      const dest = deliveryAddress?.pincode || (cust.savedAddresses || []).find(a => a.isDefault)?.pincode || cust.kyc?.pincode;
      const weight = totalWeightGrams > 0 ? totalWeightGrams / 1000 : 0.5;
      const orderAmount = payableProductTotal;
      const paymentMethodForShipping = paymentMethod === "CASHFREE" ? "prepaid" : "cod";
      
      let baseAmt = 85;
      let selectedCourier = null;
      let freeDeliveryAbove = Number(process.env.FREE_DELIVERY_ABOVE || 999);
      
      // FIRST TRY SHIPROCKET SERVICEABILITY (EXACTLY LIKE shippingRoutes)
      try {
        if (origin && dest) {
          const response = await checkServiceability({
            pickup_postcode: origin,
            delivery_postcode: dest,
            weight,
            cod: paymentMethod === "COD"
          }, { email: srEmail, password: srPassword });
          
          const data = response.data;
          const courierList = data?.data?.available_courier_companies
            || data?.data?.couriers
            || data?.couriers
            || [];

          // findBestCourier function (EXACTLY FROM shippingRoutes)
          const findBestCourier = (couriers) => {
            if (!Array.isArray(couriers)) return null;
            const delhivery = couriers.find(c => 
              String(c.name || c.courier_name || c.courier || '').toLowerCase().includes('delhivery')
            );
            if (delhivery) return delhivery;
            const blueDart = couriers.find(c => 
              String(c.name || c.courier_name || c.courier || '').toLowerCase().includes('blue dart') ||
              String(c.name || c.courier_name || c.courier || '').toLowerCase().includes('bluedart')
            );
            if (blueDart) return blueDart;
            return couriers[0];
          };
          
          if (Array.isArray(courierList) && courierList.length) {
            selectedCourier = findBestCourier(courierList);
          }

          baseAmt = Number(
            selectedCourier?.rate
            || selectedCourier?.freight_charge
            || data?.data?.available_courier_companies?.[0]?.rate
            || data?.rate
            || process.env.SHIPPING_BASE_CHARGE
            || 85
          );
        }
      } catch {
        // Fallback calculation (EXACTLY FROM shippingRoutes)
        const base = Number(process.env.SHIPPING_BASE_CHARGE || 0);
        const perKg = Number(process.env.SHIPPING_PER_KG_CHARGE || 0);
        const minCharge = Number(process.env.SHIPPING_MIN_CHARGE || 85);
        const variable = perKg * weight;
        baseAmt = Math.max(minCharge, Math.round((base + variable) * 100) / 100);
      }
      
      const isPrepaidFree = orderAmount >= freeDeliveryAbove && paymentMethodForShipping === 'prepaid';
      shippingCost = isPrepaidFree ? 0 : baseAmt;
      
      // COD charge calculation (EXACTLY FROM shippingRoutes)
      if (paymentMethod === "COD") {
        codCharge = Math.min(Math.max(Math.round(orderAmount * 0.05), 40), 100);
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

    // Setup order items for draft creation
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

    let baseTotal = 0;
    for (const it of items) {
      const p = products.find(x => x._id.toString() === it.productId.toString());
      const v = it.variantSku ? (p?.variants || []).find(v => v.sku === String(it.variantSku)) : null;
      const basePrice = v ? (v.originalStorePrice || v.price || 0) : (p?.originalStorePrice || p?.price || 0);
      baseTotal += basePrice * it.quantity;
    }
    const store = products[0]?.store;
    const adminCutPercent = store?.adminCutPercentage || 5;
    const storeRevenue = baseTotal * (1 - adminCutPercent / 100);
    const adminRevenue = totalPayable - storeRevenue;

    if (paymentMethod === "COD") {
      // COD requires 15% advance on total amount (forced to Math.ceil!)
      const advanceAmount = Math.ceil(totalPayable * 0.15);
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

      // Create draft Order
      await Order.create({
        customer: { name: nameVal, phone: cleanPhone, email: emailVal || "" },
        shippingAddress,
        items: orderItems,
        totalEstimate: totalPayable,
        productTotal: payableProductTotal,
        shippingCost: shippingCost || 0,
        codCharge: codCharge || 0,
        couponCode: couponCode?.toUpperCase() || "",
        couponDiscount: coupDiscount,
        status: "PENDING_PAYMENT",
        paymentMethod: "COD",
        paymentStatus: "PENDING",
        cashfreeOrderId: data.order_id,
        codDueAmount: codDueAmount,
        notes: "",
        store: store?._id || null,
        storeRevenue: Number(storeRevenue.toFixed(2)),
        adminRevenue: Number(adminRevenue.toFixed(2))
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

      // Create draft Order
      await Order.create({
        customer: { name: nameVal, phone: cleanPhone, email: emailVal || "" },
        shippingAddress,
        items: orderItems,
        totalEstimate: totalPayable,
        productTotal: payableProductTotal,
        shippingCost: shippingCost || 0,
        codCharge: 0,
        couponCode: couponCode?.toUpperCase() || "",
        couponDiscount: coupDiscount,
        status: "PENDING_PAYMENT",
        paymentMethod: "CASHFREE",
        paymentStatus: "PENDING",
        cashfreeOrderId: data.order_id,
        codDueAmount: 0,
        notes: "",
        store: store?._id || null,
        storeRevenue: Number(storeRevenue.toFixed(2)),
        adminRevenue: Number(adminRevenue.toFixed(2))
      });
      
      return res.json({
        cashfreeOrderId: data.order_id,
        paymentSessionId: data.payment_session_id,
        amount: totalPayable,
        totalAmount: totalPayable,
        productTotal: payableProductTotal,
        shippingCost,
        codCharge: 0,
        codDueAmount: 0,
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

  try {
    // 1. Prevent duplicate order & retrieve existing draft order
    let existingOrder = await Order.findOne({ cashfreeOrderId });
    if (existingOrder && existingOrder.paymentStatus === "PAID") {
      console.log('Order already paid and finalized:', existingOrder._id.toString());
      return res.json({ success: true, orderId: existingOrder._id, orderNumber: existingOrder.orderNumber });
    }

    // 2. Query Cashfree to verify that the order has indeed been paid
    if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
      return res.status(500).json({ error: "cashfree_not_configured" });
    }

    let cfOrderPaid = false;
    try {
      const { data: cfOrder } = await cashfree.get(`/pg/orders/${cashfreeOrderId}`);
      console.log('Cashfree order status:', cfOrder.order_status);
      if (cfOrder.order_status === "PAID") {
        cfOrderPaid = true;
      }
    } catch (err) {
      console.error("Failed to fetch order status from Cashfree:", err.response?.data || err.message);
    }

    if (!cfOrderPaid) {
      return res.status(400).json({ error: "payment_not_verified" });
    }

    // 3. Fallback: Create draft order if it doesn't exist (e.g. if prepare-payment failed to save it)
    if (!existingOrder) {
      console.log("Draft order not found, creating fallback draft order...");
      const cust = await Customer.findById(req.user.id).select("name phone email kyc address");
      if (!cust) return res.status(404).json({ error: "customer_not_found" });

      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "no_items" });

      const uniqueIds = [...new Set(items.map((x) => x.productId))];
      const products = await Product.find({ _id: { $in: uniqueIds }, isActive: true }).populate('store');
      if (products.length !== uniqueIds.length) return res.status(400).json({ error: "product_not_found" });
      
      const store = products[0]?.store;
      
      // Calculate revenues
      let baseTotal = 0;
      for (const it of items) {
        const p = products.find(x => x._id.toString() === it.productId);
        const v = it.variantSku ? (p?.variants || []).find(v => v.sku === String(it.variantSku)) : null;
        const basePrice = v ? (v.originalStorePrice || v.price || 0) : (p?.originalStorePrice || p?.price || 0);
        baseTotal += basePrice * it.quantity;
      }
      const adminCutPercent = store?.adminCutPercentage || 5;
      const storeRevenue = baseTotal * (1 - adminCutPercent / 100);

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

      const totals = computeTotals(products, items);
      const { discount: coupDiscount, finalAmount: payableProductTotal } = await validateAndApplyCoupon(couponCode, totals.total);
      
      const finalTotal = totalAmount || payableProductTotal + (shippingCost || 0) + (codCharge || 0);
      const adminRevenue = finalTotal - storeRevenue;

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

      existingOrder = await Order.create({
        customer: { name: cust.name, phone: cust.phone, email: cust.email || "" },
        shippingAddress,
        items: orderItems,
        totalEstimate: finalTotal,
        productTotal: productTotal || payableProductTotal,
        shippingCost: shippingCost || 0,
        codCharge: codCharge || 0,
        couponCode: couponCode?.toUpperCase() || "",
        couponDiscount: coupDiscount,
        status: "PENDING_PAYMENT",
        paymentMethod,
        paymentStatus: "PENDING",
        cashfreeOrderId,
        codDueAmount: paymentMethod === "COD" ? (codDueAmount || Math.round(finalTotal * 0.85)) : 0,
        notes: notes || "",
        store: store?._id || null,
        storeRevenue: Number(storeRevenue.toFixed(2)),
        adminRevenue: Number(adminRevenue.toFixed(2))
      });
    }

    // 4. Finalize order
    const finalized = await confirmAndFinalizeOrder(existingOrder, cashfreePaymentId, cashfreeSignature);

    return res.json({
      success: true,
      orderId: finalized._id,
      orderNumber: finalized.orderNumber
    });
  } catch (e) {
    console.error("Create after verify error:", e);
    return res.status(500).json({ error: "order_create_failed" });
  }
});

// GET customer own order details
router.get("/my/:id", auth, requireRole("customer"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const cust = await Customer.findById(req.user.id).select("phone email savedAddresses");
    if (!cust) return res.status(404).json({ error: "customer_not_found" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "not_found" });

    // Verify ownership via phone matching or email or savedAddresses phones
    const orderPhoneClean = String(order.customer.phone || "").replace(/\D/g, "").slice(-10);
    const orderPhoneRaw = String(order.customer.phone || "").trim();
    const orderEmail = String(order.customer.email || "").trim().toLowerCase();

    const custPhones = new Set();
    if (cust.phone) {
      custPhones.add(String(cust.phone).trim());
      custPhones.add(String(cust.phone).replace(/\D/g, "").slice(-10));
    }
    (cust.savedAddresses || []).forEach(a => {
      if (a.phone) {
        custPhones.add(String(a.phone).trim());
        custPhones.add(String(a.phone).replace(/\D/g, "").slice(-10));
      }
    });

    const custEmail = cust.email ? String(cust.email).trim().toLowerCase() : "";

    const matchesPhone = custPhones.has(orderPhoneRaw) || (orderPhoneClean.length === 10 && custPhones.has(orderPhoneClean));
    const matchesEmail = orderEmail && custEmail && orderEmail === custEmail;

    if (!matchesPhone && !matchesEmail) {
      return res.status(403).json({ error: "forbidden" });
    }

    res.json(order);
  } catch (err) {
    console.error("Failed to fetch customer order:", err);
    res.status(500).json({ error: "failed_to_fetch_order" });
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
  const items = await Order.find({ 
    "customer.phone": phone, 
    paymentStatus: { $ne: "FAILED" },
    status: { $nin: ["PENDING", "PENDING_PAYMENT"] }
  }).sort({ createdAt: -1 });
  res.json(items);
});

router.get("/my", auth, requireRole("customer"), async (req, res) => {
  try {
    const cust = await Customer.findById(req.user.id).select("phone email savedAddresses");
    if (!cust) return res.status(404).json({ error: "not_found" });

    const phones = new Set();
    if (cust.phone) {
      phones.add(String(cust.phone).trim());
      const cleaned = String(cust.phone).replace(/\D/g, "").slice(-10);
      if (cleaned.length === 10) phones.add(cleaned);
    }
    (cust.savedAddresses || []).forEach(a => {
      if (a.phone) {
        phones.add(String(a.phone).trim());
        const cleaned = String(a.phone).replace(/\D/g, "").slice(-10);
        if (cleaned.length === 10) phones.add(cleaned);
      }
    });

    const phoneList = Array.from(phones);
    const email = cust.email ? String(cust.email).trim().toLowerCase() : "";

    const orClauses = [
      { "customer.phone": { $in: phoneList } }
    ];
    if (email) {
      orClauses.push({ "customer.email": email });
    }

    const items = await Order.find({ 
      $or: orClauses, 
      paymentStatus: { $ne: "FAILED" },
      status: { $nin: ["PENDING", "PENDING_PAYMENT"] }
    }).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    console.error("Failed to fetch customer orders list:", err);
    res.status(500).json({ error: "failed_to_fetch_orders" });
  }
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
    
    if (order.paymentStatus !== "PAID" || !["CASHFREE", "COD"].includes(order.paymentMethod)) {
      return res.status(400).json({ error: "cannot_cancel_unpaid_order" });
    }
    
    // Calculate refund amount based on amount actually paid
    const amountPaid = order.paymentMethod === "COD" ? (order.totalEstimate - order.codDueAmount) : order.totalEstimate;
    const refundAmount = Math.max(0, Math.round((amountPaid * 0.95) * 100) / 100);
    const deductionAmount = amountPaid - refundAmount;
    
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

// Customer-side order cancellation
router.post("/:id/cancel-customer", auth, requireRole("customer"), async (req, res) => {
  const { reason } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  
  try {
    const cust = await Customer.findById(req.user.id).select("phone email savedAddresses");
    if (!cust) return res.status(404).json({ error: "customer_not_found" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "order_not_found" });

    // Ensure the order belongs to this customer
    const orderPhoneClean = String(order.customer.phone || "").replace(/\D/g, "").slice(-10);
    const orderPhoneRaw = String(order.customer.phone || "").trim();
    const orderEmail = String(order.customer.email || "").trim().toLowerCase();

    const custPhones = new Set();
    if (cust.phone) {
      custPhones.add(String(cust.phone).trim());
      custPhones.add(String(cust.phone).replace(/\D/g, "").slice(-10));
    }
    (cust.savedAddresses || []).forEach(a => {
      if (a.phone) {
        custPhones.add(String(a.phone).trim());
        custPhones.add(String(a.phone).replace(/\D/g, "").slice(-10));
      }
    });

    const custEmail = cust.email ? String(cust.email).trim().toLowerCase() : "";

    const matchesPhone = custPhones.has(orderPhoneRaw) || (orderPhoneClean.length === 10 && custPhones.has(orderPhoneClean));
    const matchesEmail = orderEmail && custEmail && orderEmail === custEmail;

    if (!matchesPhone && !matchesEmail) {
      return res.status(403).json({ error: "forbidden" });
    }

    // Check if order can be cancelled
    if (["CANCELLED", "RETURNED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "FULFILLED"].includes(order.status)) {
      return res.status(400).json({ error: "cannot_cancel_shipped_order" });
    }

    if (order.shipping?.waybill || order.shiprocketOrderId || order.shiprocketAwbNumber) {
      return res.status(400).json({ error: "cannot_cancel_shipped_order" });
    }

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

    order.status = "CANCELLED";
    
    // If order was paid via Cashfree, initiate refund of paid amount
    const amountPaid = order.paymentStatus === "PAID" && ["CASHFREE", "COD"].includes(order.paymentMethod)
      ? (order.paymentMethod === "COD" ? (order.totalEstimate - order.codDueAmount) : order.totalEstimate)
      : 0;

    if (amountPaid > 0 && order.cashfreeOrderId) {
      const refundAmount = Math.max(0, Math.round((amountPaid * 0.95) * 100) / 100);
      const deductionAmount = amountPaid - refundAmount;
      
      order.refundAmount = refundAmount;
      order.refundReason = reason || "Cancelled by customer";
      order.refundStatus = "PENDING";
      
      try {
        const refundPayload = {
          refund_id: `refund_${order._id.toString()}_${Date.now()}`,
          refund_amount: refundAmount,
          refund_note: reason || "Cancelled by customer",
          refund_speed: "STANDARD"
        };
        
        const { data } = await cashfree.post(
          `/pg/orders/${order.cashfreeOrderId}/refunds`,
          refundPayload
        );
        
        order.refundId = data.refund_id;
      } catch (cashfreeErr) {
        console.error("Cashfree customer refund failed:", cashfreeErr.response?.data || cashfreeErr.message);
        order.refundStatus = "FAILED";
        await order.save();
        
        return res.status(500).json({
          error: "order_cancelled_but_refund_failed",
          message: "Order has been cancelled, but refund failed. Please contact support.",
          order
        });
      }
    }

    await order.save();
    
    // Log audit
    await AuditLog.create({
      actorId: req.user.id,
      actorRole: "customer",
      type: "ORDER_CANCEL",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: `Order cancelled by customer. Reason: ${reason || "None"}`
    });

    res.json({
      success: true,
      message: "Order cancelled successfully",
      order
    });
  } catch (e) {
    console.error("Cancel customer order error:", e);
    res.status(500).json({ error: "cancel_failed", message: e.message });
  }
});

// Admin status patch
router.patch("/:id/status", auth, requirePermission("orders"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "not_found" });

    order.status = req.body.status;
    if (["DELIVERED", "FULFILLED"].includes(req.body.status)) {
      order.paymentStatus = "PAID";
      try {
        await createBillFromData({
          customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
          items: order.items.map(it => ({ product: it.product, variantSku: it.variantSku || undefined, quantity: it.quantity })),
          paymentType: order.paymentMethod,
          existingOrderId: order._id
        });
      } catch (err) {}
    }
    await order.save();
    
    await AuditLog.create({
      actorId: req.user.id,
      actorRole: req.user.role,
      type: "ORDER_STATUS",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: `Status updated to ${req.body.status}`
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "status_update_failed" });
  }
});

// Admin pack order patch
router.patch("/:id/pack", auth, requirePermission("orders"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "not_found" });

    order.status = "PACKED";
    await order.save();

    await AuditLog.create({
      actorId: req.user.id,
      actorRole: req.user.role,
      type: "ORDER_STATUS",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: "Order marked as Packed"
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "pack_failed" });
  }
});

// Admin deliver order patch
router.patch("/:id/deliver", auth, requirePermission("orders"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "not_found" });

    order.status = "DELIVERED";
    order.paymentStatus = "PAID";
    await order.save();

    try {
      await createBillFromData({
        customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
        items: order.items.map(it => ({ product: it.product, variantSku: it.variantSku || undefined, quantity: it.quantity })),
        paymentType: order.paymentMethod,
        existingOrderId: order._id
      });
    } catch (err) {}

    await AuditLog.create({
      actorId: req.user.id,
      actorRole: req.user.role,
      type: "ORDER_STATUS",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: "Order marked as Delivered"
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "deliver_failed" });
  }
});

// Admin finalize COD
router.patch("/:id/finalize-cod", auth, requirePermission("orders"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "not_found" });

    order.paymentStatus = "PAID";
    order.status = "DELIVERED";
    await order.save();

    try {
      await createBillFromData({
        customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
        items: order.items.map(it => ({ product: it.product, variantSku: it.variantSku || undefined, quantity: it.quantity })),
        paymentType: order.paymentMethod,
        existingOrderId: order._id
      });
    } catch (err) {}

    await AuditLog.create({
      actorId: req.user.id,
      actorRole: req.user.role,
      type: "ORDER_STATUS",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: "COD finalized and marked Delivered"
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "finalize_cod_failed" });
  }
});

// Admin standard delhivery shipment map to shiprocket
router.post("/:id/delhivery/standard-shipment", auth, requirePermission("orders"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "not_found" });

    const updated = await tryCreateShiprocketShipment(order);
    if (updated && updated.shipping?.waybill) {
      res.json({ success: true, waybill: updated.shipping.waybill });
    } else {
      res.status(400).json({ error: "shipment_creation_failed", message: "Failed to create Shiprocket shipment. Please verify pincodes or configuration." });
    }
  } catch (err) {
    res.status(500).json({ error: "shipment_creation_failed", message: err.message });
  }
});

// Repay for failed payments
router.post("/:id/repay", auth, requireRole("customer"), async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: "order_not_found" });
    }
    if (order.paymentStatus !== "FAILED" && order.paymentStatus !== "PENDING") {
      return res.status(400).json({ error: "cannot_repay" });
    }
    // Check if customer owns the order
    const customer = await Customer.findOne({ user: req.user.id });
    if (!customer || order.customer.phone !== customer.phone) {
      return res.status(403).json({ error: "forbidden" });
    }
    // Re-initiate payment (similar to prepare-payment)
    const paymentPayload = {
      order_id: order._id.toString(),
      order_amount: order.totalEstimate,
      order_currency: "INR",
      customer_details: {
        customer_id: customer._id.toString(),
        customer_name: order.customer.name,
        customer_email: order.customer.email || "customer@example.com",
        customer_phone: order.customer.phone
      },
      order_meta: {
        return_url: `${process.env.FRONTEND_URL}/orders/${order._id}`,
        notify_url: `${process.env.BACKEND_URL}/api/orders/webhook`
      }
    };
    const { data } = await authCashfree().post("/pg/orders", paymentPayload);
    order.cashfreeOrderId = data.order_id;
    order.paymentStatus = "PENDING";
    order.status = "PENDING_PAYMENT";
    await order.save();
    await AuditLog.create({
      actorId: req.user.id,
      actorRole: "customer",
      type: "ORDER_PAYMENT_RETRY",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: "Retried payment"
    });
    res.json({ success: true, payment_session_id: data.payment_session_id, order_id: data.order_id });
  } catch (err) {
    res.status(500).json({ error: "repay_failed", message: err.message });
  }
});

// Update order status
router.put("/:id/status", auth, requireRole(["admin", "seller"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ["PENDING", "PENDING_PAYMENT", "CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RETURNED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "invalid_status" });
    }
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: "order_not_found" });
    }
    // If seller, check if order belongs to their store
    if (req.user.role === "seller") {
      const store = await Store.findOne({ user: req.user.id });
      if (!store || order.store.toString() !== store._id.toString()) {
        return res.status(403).json({ error: "forbidden" });
      }
    }
    order.status = status;
    await order.save();
    await AuditLog.create({
      actorId: req.user.id,
      actorRole: req.user.role,
      type: "ORDER_STATUS",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: `Order status changed to ${status}`
    });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: "update_failed" });
  }
});

export default router;
