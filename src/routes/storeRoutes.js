import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import mongoose from "mongoose";
import Store from "../models/Store.js";
import StoreRequest from "../models/StoreRequest.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import Category from "../models/Category.js";
import SubCategory from "../models/SubCategory.js";
import Brand from "../models/Brand.js";
import AuditLog from "../models/AuditLog.js";
import StockTxn from "../models/StockTxn.js";
import { sendEmail } from "../lib/mailer.js";
import { delCache, bumpCacheVersion } from "../lib/redis.js";

const normalizeSpecifications = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => ({
      key: String(s?.key ?? s?.name ?? "").trim(),
      value: String(s?.value ?? "").trim()
    }))
    .filter((s) => s.key && s.value)
    .slice(0, 40);
};

const router = express.Router();

// Generate JWT token
const generateToken = (id) => {
  return jwt.sign({ id, role: "store" }, process.env.JWT_SECRET, { expiresIn: "30d" });
};

// Store login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const store = await Store.findOne({ email });

    if (!store || !(await store.comparePassword(password))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!store.isActive) {
      return res.status(403).json({ error: "Store account is inactive" });
    }

    res.json({
      _id: store._id,
      name: store.name,
      email: store.email,
      phone: store.phone,
      token: generateToken(store._id)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Store forgot password
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const store = await Store.findOne({ email });

    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    store.resetPasswordToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    store.resetPasswordExpires = Date.now() + 3600000; // 1 hour

    await store.save();

    const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/business/reset-password?token=${resetToken}`;

    // Send email
    try {
      await sendEmail({
        to: store.email,
        subject: "Password Reset Request - SmartOdisha Business",
        html: `<p>Hi ${store.name},</p>
               <p>You requested a password reset. Click the link below to reset your password:</p>
               <a href="${resetUrl}">${resetUrl}</a>
               <p>This link will expire in 1 hour.</p>`
      });
    } catch (emailErr) {
      console.error("Email send failed:", emailErr);
    }

    res.json({ message: "Password reset link sent to email" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// Store reset password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    const resetPasswordToken = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const store = await Store.findOne({
      resetPasswordToken,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!store) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    store.password = password;
    store.resetPasswordToken = undefined;
    store.resetPasswordExpires = undefined;
    await store.save();

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// Store request (for new stores to join)
router.post("/request", async (req, res) => {
  try {
    const { name, email, phone, businessName, address, message } = req.body;

    const existingRequest = await StoreRequest.findOne({
      $or: [{ email }, { phone }],
      status: "pending"
    });

    if (existingRequest) {
      return res.status(400).json({ error: "You already have a pending request" });
    }

    const storeRequest = await StoreRequest.create({
      name,
      email,
      phone,
      businessName,
      address,
      message
    });

    res.status(201).json({ message: "Request submitted successfully", storeRequest });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit request" });
  }
});

// Middleware to protect store routes
const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.query.token) { // Also accept token from query string (for PDF downloads)
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "Not authorized" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const store = await Store.findById(decoded.id).select("-password");

    if (!store) {
      return res.status(401).json({ error: "Store not found" });
    }

    req.store = store;
    next();
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: "Invalid token" });
  }
};

// Get current store profile
router.get("/profile", protect, async (req, res) => {
  try {
    res.json(req.store);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Update store profile
router.put("/profile", protect, async (req, res) => {
  try {
    const { name, phone, address, gstNumber, pickupAddress, pickupName, pickupPhone, shiprocketEmail, shiprocketPassword, image, sellerAvatar } = req.body;
    const store = await Store.findById(req.store._id);

    if (store) {
      store.name = name || store.name;
      store.phone = phone || store.phone;
      store.address = address || store.address;
      store.gstNumber = gstNumber || store.gstNumber;
      store.pickupAddress = pickupAddress || store.pickupAddress;
      store.pickupName = pickupName || store.pickupName;
      store.pickupPhone = pickupPhone || store.pickupPhone;
      store.shiprocketEmail = shiprocketEmail || store.shiprocketEmail;
      store.shiprocketPassword = shiprocketPassword || store.shiprocketPassword;
      
      // Update image if provided
      if (image) {
        if (typeof image === "string") {
          store.image = { url: image };
        } else if (image.url) {
          store.image = image;
        }
      }
      
      // Update seller avatar if provided
      if (sellerAvatar !== undefined) { // Handle both setting and clearing
        if (sellerAvatar) {
          if (typeof sellerAvatar === "string") {
            store.sellerAvatar = { url: sellerAvatar };
          } else if (sellerAvatar.url) {
            store.sellerAvatar = sellerAvatar;
          }
        } else {
          store.sellerAvatar = null;
        }
      }

      const updatedStore = await store.save();
      res.json(updatedStore);
    } else {
      res.status(404).json({ error: "Store not found" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// Get store products
router.get("/products", protect, async (req, res) => {
  try {
    const products = await Product.find({ store: req.store._id }).sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Get single product for store
router.get("/products/:id", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    const product = await Product.findOne({ _id: req.params.id, store: req.store._id });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// Get store orders
router.get("/orders", protect, async (req, res) => {
  try {
    // Now we can just find orders where store matches, exclude pending/pending_payment/failed
    const orders = await Order.find({ 
      store: req.store._id,
      paymentStatus: { $ne: "FAILED" },
      status: { $nin: ["PENDING", "PENDING_PAYMENT"] }
    }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// Update order status (seller)
router.patch("/orders/:id/status", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findOne({ _id: req.params.id, store: req.store._id });
    if (!order) return res.status(404).json({ error: "order_not_found" });

    order.status = req.body.status;
    if (["DELIVERED", "FULFILLED"].includes(req.body.status)) {
      order.paymentStatus = "PAID";
      try {
        const { createBillFromData } = await import("../lib/billing.js");
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
      actorId: req.store._id,
      actorRole: "store",
      type: "ORDER_STATUS",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: `Status updated by store to ${req.body.status}`
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "status_update_failed" });
  }
});

// Mark order as Packed (seller)
router.patch("/orders/:id/pack", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findOne({ _id: req.params.id, store: req.store._id });
    if (!order) return res.status(404).json({ error: "order_not_found" });

    order.status = "PACKED";
    await order.save();

    await AuditLog.create({
      actorId: req.store._id,
      actorRole: "store",
      type: "ORDER_STATUS",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: "Order marked Packed by store"
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "pack_failed" });
  }
});

// Mark order as Delivered (seller)
router.patch("/orders/:id/deliver", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findOne({ _id: req.params.id, store: req.store._id });
    if (!order) return res.status(404).json({ error: "order_not_found" });

    order.status = "DELIVERED";
    order.paymentStatus = "PAID";
    await order.save();

    try {
      const { createBillFromData } = await import("../lib/billing.js");
      await createBillFromData({
        customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
        items: order.items.map(it => ({ product: it.product, variantSku: it.variantSku || undefined, quantity: it.quantity })),
        paymentType: order.paymentMethod,
        existingOrderId: order._id
      });
    } catch (err) {}

    await AuditLog.create({
      actorId: req.store._id,
      actorRole: "store",
      type: "ORDER_STATUS",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: "Order marked Delivered by store"
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "deliver_failed" });
  }
});

// Cancel Order (seller)
router.post("/orders/:id/cancel", protect, async (req, res) => {
  const { reason } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });

  try {
    const order = await Order.findOne({ _id: req.params.id, store: req.store._id });
    if (!order) return res.status(404).json({ error: "order_not_found" });

    if (["CANCELLED", "RETURNED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "FULFILLED"].includes(order.status)) {
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

    // Initiate Cashfree refund if order was paid online
    const amountPaid = order.paymentStatus === "PAID" && ["CASHFREE", "COD"].includes(order.paymentMethod)
      ? (order.paymentMethod === "COD" ? (order.totalEstimate - order.codDueAmount) : order.totalEstimate)
      : 0;

    if (amountPaid > 0 && order.cashfreeOrderId) {
      const refundAmount = Math.max(0, Math.round((amountPaid * 0.95) * 100) / 100);
      const deductionAmount = amountPaid - refundAmount;

      order.refundAmount = refundAmount;
      order.refundReason = reason || "Cancelled by store";
      order.refundStatus = "PENDING";

      try {
        const cashfree = (await import("../lib/cashfree.js")).default;
        const refundPayload = {
          refund_id: `refund_${order._id.toString()}_${Date.now()}`,
          refund_amount: refundAmount,
          refund_note: reason || "Cancelled by store",
          refund_speed: "STANDARD"
        };

        const { data } = await cashfree.post(
          `/pg/orders/${order.cashfreeOrderId}/refunds`,
          refundPayload
        );

        order.refundId = data.refund_id;
      } catch (cashfreeErr) {
        console.error("Cashfree store cancellation refund failed:", cashfreeErr.response?.data || cashfreeErr.message);
        order.refundStatus = "FAILED";
        await order.save();

        return res.status(500).json({
          error: "order_cancelled_but_refund_failed",
          message: "Order has been cancelled, but refund failed. Please contact admin.",
          order
        });
      }
    }

    await order.save();

    await AuditLog.create({
      actorId: req.store._id,
      actorRole: "store",
      type: "ORDER_CANCEL",
      entityType: "ORDER",
      entityId: order._id.toString(),
      note: `Order cancelled by store manager. Reason: ${reason || "None"}`
    });

    res.json({ success: true, message: "Order cancelled successfully", order });
  } catch (err) {
    console.error("Seller cancel order failed:", err);
    res.status(500).json({ error: "cancel_failed", message: err.message });
  }
});

// Create Shiprocket shipment (seller)
router.post("/orders/:id/shiprocket/create", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findOne({ _id: req.params.id, store: req.store._id });
    if (!order) return res.status(404).json({ error: "order_not_found" });

    const Customer = (await import("../models/Customer.js")).default;
    const { checkServiceability, createShiprocketClient } = await import("../lib/shiprocket.js");

    let srEmail = req.store.shiprocketEmail || process.env.SHIPROCKET_EMAIL;
    let srPassword = req.store.shiprocketPassword || process.env.SHIPROCKET_PASSWORD;
    let pickupPincode = req.store.pickupAddress?.pincode || process.env.SHIPROCKET_PICKUP_PINCODE || "360001";
    let pickupLocation = req.store.pickupName || process.env.SHIPROCKET_PICKUP_NAME || "Warehouse";

    if (!srEmail || !srPassword) {
      return res.status(400).json({ error: "shiprocket_credentials_missing", message: "Shiprocket credentials are not configured for this store." });
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
        }
      }
    }

    if (!addr.pincode || !addr.line1) {
      return res.status(400).json({ error: "shipping_address_missing", message: "Customer shipping address or pincode is incomplete." });
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
        console.log("Dynamically resolved Shiprocket pickup location nickname for store order:", pickupLocation);
      }
    } catch (locErr) {
      console.error("Failed to fetch Shiprocket pickup locations for store, falling back to:", pickupLocation, locErr.message);
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

    const { data } = await client.post("/orders/create/adhoc", shipment);

    const awb = data.awb_code;
    const trackingUrl = `https://shiprocket.co/tracking/${awb}`;

    if (awb) {
      order.shipping = { provider: "SHIPROCKET", waybill: awb, status: data.status || "CREATED", trackingUrl };
      order.shiprocketOrderId = data.order_id;
      order.shiprocketShipmentId = data.shipment_id;
      order.shiprocketAwbNumber = awb;
      order.shipment_status = data.status;
      order.shippingAddress = addr;
      order.status = "SHIPPED";
      await order.save();

      await AuditLog.create({
        actorId: req.store._id,
        actorRole: "store",
        type: "ORDER_STATUS",
        entityType: "ORDER",
        entityId: order._id.toString(),
        note: `Shiprocket shipment created. AWB: ${awb}`
      });

      return res.json({ success: true, waybill: awb, trackingUrl, status: order.status });
    }

    return res.status(400).json({ error: "shipment_creation_failed", message: "Failed to generate AWB code from Shiprocket." });
  } catch (err) {
    console.error("Seller shiprocket create failed:", err.response?.data || err.message);
    res.status(502).json({ error: "shipment_creation_failed", message: err.response?.data?.message || err.message });
  }
});

// Download Shiprocket PDF Label (seller)
router.get("/orders/:id/shiprocket/label/:awb", protect, async (req, res) => {
  const awb = req.params.awb;
  try {
    const order = await Order.findOne({ _id: req.params.id, store: req.store._id });
    if (!order) return res.status(404).json({ error: "order_not_found" });

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
    const { createShiprocketClient } = await import("../lib/shiprocket.js");
    const client = createShiprocketClient({ email: srEmail, password: srPassword });

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
      // Fallback to Shiprocket's label endpoint if needed
      const trackingResponse = await client.get(`/courier/track/awb/${awb}`);
      // If nothing else, try another approach or fall back
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
    console.error("Seller shiprocket label failed:", err.response?.data || err.message);
    // Fallback to custom PDF if Shiprocket fails
    try {
      const order = await Order.findOne({ _id: req.params.id, store: req.store._id }).lean();
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
    } catch (fallbackErr) {
      res.status(500).json({ error: "label_generation_failed", message: fallbackErr.message });
    }
  }
});

// Get dashboard stats
router.get("/dashboard", protect, async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments({ store: req.store._id });
    const activeProducts = await Product.countDocuments({ store: req.store._id, isActive: true });
    const outOfStock = await Product.countDocuments({ store: req.store._id, stock: 0 });

    // Get recent orders
    const recentOrders = await Order.find({ store: req.store._id }).sort({ createdAt: -1 }).limit(10);

    // Calculate total revenue
    const totalRevenue = await Order.aggregate([
      { $match: { store: req.store._id } },
      { $group: { _id: null, total: { $sum: "$storeRevenue" } } }
    ]);

    res.json({
      totalProducts,
      activeProducts,
      outOfStock,
      totalRevenue: totalRevenue[0]?.total || 0,
      recentOrders
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

// Store products CRUD
router.post("/products", protect, async (req, res) => {
  try {
    const { name, price, categoryId, subCategoryId, images, stock, weight, gst, description, highlights, specifications, bulkDiscountQuantity, bulkDiscountPriceReduction, mrp, bulkTiers, variants, brandId, minOrderQty, section, hsnCode, sku, packSize } = req.body || {};
    if (!name || price == null || stock == null || !categoryId) return res.status(400).json({ error: "missing_fields" });
    
    if (brandId && !mongoose.isValidObjectId(brandId)) return res.status(400).json({ error: "invalid_brand" });
    if (!mongoose.isValidObjectId(categoryId)) return res.status(400).json({ error: "invalid_category" });
    if (subCategoryId && !mongoose.isValidObjectId(subCategoryId)) return res.status(400).json({ error: "invalid_subcategory" });

    const imgArr = Array.isArray(images)
      ? images.map((i) => (typeof i === "string" ? { url: i } : i)).filter((i) => i && i.url)
      : [];

    const doc = await Product.create({
      name: String(name).trim(),
      description: description || "",
      price: Number(price),
      originalStorePrice: Number(price),
      sku: sku ? String(sku).trim() : undefined,
      hsnCode: hsnCode ? String(hsnCode).trim() : "",
      brand: brandId || null,
      category: categoryId,
      subCategory: subCategoryId || undefined,
      images: imgArr,
      stock: Number(stock),
      weight: Number(weight || 0),
      gst: gst == null ? 0 : Number(gst),
      mrp: mrp == null || mrp === "" ? undefined : Number(mrp),
      priceTrend: 0, 
      store: req.store._id,
      section: section ? String(section).trim() : "",
      minOrderQty: Number(minOrderQty || 0),
      packSize: Number(packSize || 1),
      highlights: Array.isArray(highlights) ? highlights.map(h => String(h || '').trim()).filter(Boolean).slice(0, 12) : [],
      specifications: normalizeSpecifications(specifications),
      bulkDiscountQuantity: Number(bulkDiscountQuantity || 0),
      bulkDiscountPriceReduction: Number(bulkDiscountPriceReduction || 0),
      bulkTiers: Array.isArray(bulkTiers)
        ? bulkTiers
            .map(t => ({ quantity: Number(t?.quantity), priceReduction: Number(t?.priceReduction) }))
            .filter(t => Number.isFinite(t.quantity) && t.quantity > 0 && Number.isFinite(t.priceReduction) && t.priceReduction >= 0)
            .sort((a,b) => a.quantity - b.quantity)
        : [],
      attributes: Array.isArray(req.body.attributes) ? req.body.attributes.map(a => String(a || '').trim().toLowerCase()).filter(Boolean) : [],
      variants: Array.isArray(variants) ? variants.map(v => {
        const variantAttrs = {};
        if (v.attributes && typeof v.attributes === 'object') {
          Object.entries(v.attributes).forEach(([key, val]) => {
            variantAttrs[key.toLowerCase()] = String(val || '').trim();
          });
        }
        return {
          _id: v._id || new mongoose.Types.ObjectId(),
          attributes: variantAttrs,
          price: Number(v?.price ?? price),
          originalStorePrice: Number(v?.price ?? price),
          mrp: v?.mrp == null ? undefined : Number(v?.mrp),
          stock: Number(v?.stock ?? 0),
          sku: v?.sku ? String(v.sku).trim() : "",
          weight: Number(v?.weight ?? weight ?? 0),
          isActive: v?.isActive != null ? !!v.isActive : true,
          images: Array.isArray(v?.images) ? v.images.map(i => (typeof i === "string" ? { url: i } : i)).filter(i => i && i.url) : []
        };
      }) : []
    });

    try {
      if ((doc.variants || []).length > 0) {
        const sum = (doc.variants || []).filter(v => v.isActive !== false).reduce((s, v) => s + Number(v.stock || 0), 0);
        if (Number.isFinite(sum)) {
          doc.stock = sum;
          await doc.save();
        }
      }
    } catch {}

    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create product" });
  }
});

router.put("/products/:id", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    
    const beforeDoc = await Product.findById(req.params.id);
    if (!beforeDoc) return res.status(404).json({ error: "not_found" });
    if (beforeDoc.store?.toString() !== req.store._id.toString()) {
      return res.status(403).json({ error: "forbidden" });
    }

    const allowed = ["name", "description", "highlights", "specifications", "price", "categoryId", "subCategoryId", "images", "stock", "weight", "gst", "mrp", "isActive", "bulkDiscountQuantity", "bulkDiscountPriceReduction", "bulkTiers", "variants", "brandId", "minOrderQty", "section", "hsnCode", "sku", "packSize"];
    const payload = {};
    for (const k of allowed) if (k in req.body) payload[k] = req.body[k];
    if (payload.packSize !== undefined) payload.packSize = Number(payload.packSize || 1);

    if (payload.brandId) {
      if (!mongoose.isValidObjectId(payload.brandId)) return res.status(400).json({ error: "invalid_brand" });
      payload.brand = payload.brandId;
      delete payload.brandId;
    }
    if (payload.categoryId) {
      if (!mongoose.isValidObjectId(payload.categoryId)) return res.status(400).json({ error: "invalid_category" });
      payload.category = payload.categoryId;
      delete payload.categoryId;
    }
    if (payload.subCategoryId !== undefined) {
      if (payload.subCategoryId === null || payload.subCategoryId === "") {
        payload.subCategory = null;
      } else {
        if (!mongoose.isValidObjectId(payload.subCategoryId)) return res.status(400).json({ error: "invalid_subcategory" });
        payload.subCategory = payload.subCategoryId;
      }
      delete payload.subCategoryId;
    }
    if (Array.isArray(payload.images)) payload.images = payload.images.map((i) => (typeof i === "string" ? { url: i } : i)).filter((i) => i && i.url);
    if (Array.isArray(payload.highlights)) {
      payload.highlights = payload.highlights.map(h => String(h || '').trim()).filter(Boolean).slice(0, 12);
    }
    if (Array.isArray(payload.specifications)) {
      payload.specifications = normalizeSpecifications(payload.specifications);
    }
    if (Array.isArray(payload.bulkTiers)) {
      payload.bulkTiers = payload.bulkTiers
        .map(t => ({ quantity: Number(t?.quantity), priceReduction: Number(t?.priceReduction) }))
        .filter(t => Number.isFinite(t.quantity) && t.quantity > 0 && Number.isFinite(t.priceReduction) && t.priceReduction >= 0)
        .sort((a,b) => a.quantity - b.quantity);
    }
    if (Array.isArray(payload.attributes)) {
      payload.attributes = payload.attributes.map(a => String(a || '').trim().toLowerCase()).filter(Boolean);
    }

    if (payload.price !== undefined) {
      payload.originalStorePrice = Number(payload.price);
    }

    if (Array.isArray(payload.variants) && payload.variants.length > 0) {
      payload.variants = payload.variants.map(v => {
        const variantAttrs = {};
        if (v.attributes && typeof v.attributes === 'object') {
          Object.entries(v.attributes).forEach(([key, val]) => {
            variantAttrs[key.toLowerCase()] = String(val || '').trim();
          });
        }
        let existingStock = 0;
        if (v._id && beforeDoc && beforeDoc.variants) {
          const existing = beforeDoc.variants.find(ex => ex._id.toString() === v._id.toString());
          if (existing) existingStock = existing.stock || 0;
        }
        return {
          _id: v._id || new mongoose.Types.ObjectId(),
          attributes: variantAttrs,
          price: Number(v?.price ?? 0),
          originalStorePrice: Number(v?.price ?? 0),
          mrp: v?.mrp == null ? undefined : Number(v?.mrp),
          stock: v.stock != null ? Number(v.stock) : existingStock,
          sku: v?.sku ? String(v.sku).trim() : "",
          weight: Number(v?.weight ?? 0),
          isActive: v?.isActive != null ? !!v.isActive : true,
          images: Array.isArray(v?.images) ? v.images.map(i => (typeof i === "string" ? { url: i } : i)).filter(i => i && i.url) : []
        };
      });
      const sum = payload.variants.filter(v => v.isActive !== false).reduce((s, v) => s + Number(v.stock || 0), 0);
      payload.stock = Number.isFinite(sum) ? sum : 0;
    } else if (Array.isArray(payload.variants) && payload.variants.length === 0) {
      delete payload.variants;
    } else {
      if (!("stock" in req.body) && beforeDoc) {
        payload.stock = beforeDoc.stock;
      }
    }

    if (payload.price != null && beforeDoc) {
      const newPrice = Number(payload.price);
      const oldPrice = Number(beforeDoc.price);
      const mrp = payload.mrp != null ? Number(payload.mrp) : (beforeDoc.mrp ? Number(beforeDoc.mrp) : newPrice);
      if (newPrice > mrp) {
        return res.status(400).json({ error: "price_cannot_exceed_mrp" });
      }
      payload.priceTrend = newPrice > oldPrice ? 1 : 0;
    }

    const updated = await Product.findByIdAndUpdate(req.params.id, payload, { new: true });
    
    try {
      const changes = {};
      if (beforeDoc) {
        if (payload.price != null && Number(beforeDoc.price) !== Number(payload.price)) changes.price = { before: beforeDoc.price, after: payload.price };
        if (payload.gst != null && Number(beforeDoc.gst) !== Number(payload.gst)) changes.gst = { before: beforeDoc.gst, after: payload.gst };
        if (payload.minOrderQty != null && Number(beforeDoc.minOrderQty) !== Number(payload.minOrderQty)) changes.minOrderQty = { before: beforeDoc.minOrderQty, after: payload.minOrderQty };
        if (Array.isArray(payload.bulkTiers)) changes.bulkTiers = { before: beforeDoc.bulkTiers, after: payload.bulkTiers };
      }
      if (Object.keys(changes).length) {
        await AuditLog.create({
          actorId: req.store?._id || "",
          actorRole: "store",
          type: "PRODUCT_UPDATE",
          entityType: "PRODUCT",
          entityId: updated._id.toString(),
          before: changes,
          after: null,
          note: "Product updated by store"
        });
      }
    } catch {}

    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

router.delete("/products/:id", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "not_found" });
    if (product.store?.toString() !== req.store._id.toString()) {
      return res.status(403).json({ error: "forbidden" });
    }

    product.isActive = false;
    await product.save();
    
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

router.patch("/products/:id/stock", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    const qty = Number(req.body?.quantity);
    if (!Number.isInteger(qty) || qty === 0) return res.status(400).json({ error: "invalid_quantity" });
    
    const doc = await Product.findById(req.params.id);
    if (!doc || !doc.isActive) return res.status(404).json({ error: "not_found" });
    if (doc.store?.toString() !== req.store._id.toString()) return res.status(403).json({ error: "forbidden" });

    if (doc.stock + qty < 0) return res.status(400).json({ error: "insufficient_stock" });
    const before = doc.stock;
    doc.stock += qty;
    await doc.save();
    
    await StockTxn.create({ 
      product: doc._id, 
      type: "ADJUST", 
      quantity: qty, 
      before, 
      after: doc.stock, 
      refType: "MANUAL", 
      note: req.body?.note || `Manual Adjustment (${qty > 0 ? '+' : ''}${qty})`
    });
    
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.json({ id: doc._id.toString(), stock: doc.stock });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to adjust stock" });
  }
});

// Store variants CRUD
router.post("/products/:id/variants", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    const p = await Product.findById(req.params.id);
    if (!p || !p.isActive) return res.status(404).json({ error: "not_found" });
    if (p.store?.toString() !== req.store._id.toString()) return res.status(403).json({ error: "forbidden" });
    
    const v = req.body || {};
    const sku = v?.sku ? String(v.sku).trim() : undefined;
    if (sku) {
      const conflict = await Product.findOne({ "variants.sku": sku });
      if (conflict) return res.status(400).json({ error: "sku_exists" });
    }
    const attrs = new Map();
    if (v?.attributes && typeof v.attributes === 'object') {
      Object.entries(v.attributes).forEach(([key, val]) => {
        if (key && val) attrs.set(key.toLowerCase().trim(), String(val).trim());
      });
    }
    
    const duplicate = (p.variants || []).find(x => {
      const xAttrs = x.attributes instanceof Map ? Object.fromEntries(x.attributes) : (x.attributes || {});
      const keys = Array.from(attrs.keys());
      const xKeys = Object.keys(xAttrs);
      if (keys.length !== xKeys.length) return false;
      return keys.every(k => String(xAttrs[k] || '').toLowerCase() === String(attrs.get(k) || '').toLowerCase());
    });
    if (duplicate) return res.status(400).json({ error: "duplicate_variant" });
    
    const newVar = {
      _id: new mongoose.Types.ObjectId(),
      attributes: attrs,
      price: Number(v?.price ?? p.price ?? 0),
      originalStorePrice: Number(v?.price ?? p.price ?? 0),
      mrp: v?.mrp == null ? undefined : Number(v?.mrp),
      stock: Number(v?.stock ?? 0),
      sku,
      weight: Number(v?.weight ?? p.weight ?? 0),
      isActive: v?.isActive != null ? !!v.isActive : true,
      images: Array.isArray(v?.images) ? v.images.map(i => (typeof i === "string" ? { url: i } : i)).filter(i => i && i.url) : []
    };
    
    p.variants.push(newVar);
    p.markModified("variants");
    await p.save();
    
    try {
      const sum = (p.variants || []).filter(v => v.isActive !== false).reduce((s, v) => s + Number(v.stock || 0), 0);
      p.stock = Number.isFinite(sum) ? sum : 0;
      await p.save();
    } catch {}
    
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.status(201).json(newVar);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add variant" });
  }
});

router.put("/products/:id/variants/:vid", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    const p = await Product.findById(req.params.id);
    if (!p || !p.isActive) return res.status(404).json({ error: "not_found" });
    if (p.store?.toString() !== req.store._id.toString()) return res.status(403).json({ error: "forbidden" });
    
    const idx = (p.variants || []).findIndex(v => v._id.toString() === req.params.vid);
    if (idx === -1) return res.status(404).json({ error: "variant_not_found" });
    const v = p.variants[idx];
    const payload = req.body || {};
    
    if (payload.sku !== undefined) {
      const sku = String(payload.sku || "").trim();
      if (sku) {
        const conflict = await Product.findOne({ 
          $or: [
            { sku: sku, _id: { $ne: p._id } },
            { "variants.sku": sku, _id: { $ne: p._id } },
            { _id: p._id, "variants.sku": sku, "variants._id": { $ne: new mongoose.Types.ObjectId(req.params.vid) } }
          ]
        });
        if (conflict) return res.status(400).json({ error: "sku_exists" });
      }
      v.sku = sku;
    }
    if (payload.attributes) {
      const attrs = new Map();
      if (payload.attributes && typeof payload.attributes === 'object') {
        Object.entries(payload.attributes).forEach(([key, val]) => {
          if (key && val) attrs.set(key.toLowerCase().trim(), String(val).trim());
        });
      }
      const duplicate = (p.variants || []).find((x, i) => {
        if (i === idx) return false;
        const xAttrs = x.attributes instanceof Map ? Object.fromEntries(x.attributes) : (x.attributes || {});
        const keys = Array.from(attrs.keys());
        const xKeys = Object.keys(xAttrs);
        if (keys.length !== xKeys.length) return false;
        return keys.every(k => String(xAttrs[k] || '').toLowerCase() === String(attrs.get(k) || '').toLowerCase());
      });
      if (duplicate) return res.status(400).json({ error: "duplicate_variant" });
      v.attributes = attrs;
    }
    if (payload.weight != null) v.weight = Number(payload.weight);
    if (payload.price != null) {
      v.price = Number(payload.price);
      v.originalStorePrice = Number(payload.price);
    }
    if (payload.mrp != null) v.mrp = Number(payload.mrp);
    if (payload.stock != null) {
      const qty = Number(payload.stock);
      const before = v.stock;
      v.stock = qty;
      p.stock = (p.variants || []).filter(vx => vx.isActive !== false).reduce((s, vx) => s + (vx.stock || 0), 0);
      await p.save();
      await StockTxn.create({ product: p._id, type: "ADJUST", quantity: qty, before, after: qty, variantSku: v.sku });
    }
    if (payload.isActive != null) {
      v.isActive = !!payload.isActive;
      p.stock = (p.variants || []).filter(vx => vx.isActive !== false).reduce((s, vx) => s + (vx.stock || 0), 0);
    }
    if (Array.isArray(payload.images)) v.images = payload.images.map(i => (typeof i === "string" ? { url: i } : i)).filter(i => i && i.url);
    p.markModified("variants");
    await p.save();
    
    try {
      const sum = (p.variants || []).filter(x => x.isActive !== false).reduce((s, x) => s + Number(x.stock || 0), 0);
      p.stock = Number.isFinite(sum) ? sum : 0;
      await p.save();
    } catch {}
    
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.json(v);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update variant" });
  }
});

router.delete("/products/:id/variants/:vid", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    const p = await Product.findById(req.params.id);
    if (!p || !p.isActive) return res.status(404).json({ error: "not_found" });
    if (p.store?.toString() !== req.store._id.toString()) return res.status(403).json({ error: "forbidden" });
    
    const initialCount = p.variants?.length || 0;
    p.variants = (p.variants || []).filter(v => v._id.toString() !== req.params.vid);
    
    if (p.variants.length === initialCount) return res.status(404).json({ error: "variant_not_found" });
    
    p.markModified("variants");
    await p.save();
    
    try {
      const sum = (p.variants || []).filter(x => x.isActive !== false).reduce((s, x) => s + Number(x.stock || 0), 0);
      p.stock = Number.isFinite(sum) ? sum : 0;
      await p.save();
    } catch {}
    
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete variant" });
  }
});

router.patch("/products/:id/variants/:vid/stock", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    const qty = Number(req.body?.quantity);
    if (!Number.isInteger(qty) || qty === 0) return res.status(400).json({ error: "invalid_quantity" });
    const p = await Product.findById(req.params.id);
    if (!p || !p.isActive) return res.status(404).json({ error: "not_found" });
    if (p.store?.toString() !== req.store._id.toString()) return res.status(403).json({ error: "forbidden" });
    
    const idx = (p.variants || []).findIndex(v => v._id.toString() === req.params.vid);
    if (idx === -1) return res.status(404).json({ error: "variant_not_found" });
    const v = p.variants[idx];
    if ((v.stock || 0) + qty < 0) return res.status(400).json({ error: "insufficient_stock" });
    const before = v.stock || 0;
    v.stock = before + qty;
    p.markModified("variants");
    await p.save();
    try {
      const sum = (p.variants || []).filter(x => x.isActive !== false).reduce((s, x) => s + Number(x.stock || 0), 0);
      p.stock = Number.isFinite(sum) ? sum : 0;
      await p.save();
    } catch {}
    await StockTxn.create({ product: p._id, type: "ADJUST", quantity: qty, before, after: v.stock, refType: "MANUAL", note: req.body?.note || `Manual Adjustment (${qty > 0 ? '+' : ''}${qty})`, variantSku: v.sku });
    
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.json({ id: v._id.toString(), stock: v.stock });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to adjust variant stock" });
  }
});

router.get("/products/:id/stock-history", protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    if (p.store?.toString() !== req.store._id.toString()) return res.status(403).json({ error: "forbidden" });
    
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const items = await StockTxn.find({ product: req.params.id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    res.json({ page, limit, count: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stock history" });
  }
});

// Store categories/brands creation helper
router.post("/categories", protect, async (req, res) => {
  try {
    const { name, slug, brandId, image, description, attributes } = req.body || {};
    if (!name || !slug) return res.status(400).json({ error: "missing_fields" });
    
    if (brandId && !mongoose.isValidObjectId(brandId)) return res.status(400).json({ error: "invalid_brand" });
    
    const filter = { $or: [{ name: name.toLowerCase() }, { slug: slug.toLowerCase() }] };
    if (brandId) filter.brand = brandId;
    else filter.brand = null;

    const exists = await Category.findOne(filter);
    if (exists) return res.status(409).json({ error: "duplicate_category" });
    
    const payload = {
      name: name.toLowerCase(),
      slug: slug.toLowerCase(),
      brand: brandId || null,
      image: image || "",
      description: description || "",
      attributes: Array.isArray(attributes) ? attributes.map(a => a.toLowerCase().trim()) : []
    };
    const doc = await Category.create(payload);
    await delCache("categories:all");
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create category" });
  }
});

router.post("/subcategories", protect, async (req, res) => {
  try {
    const { name, slug, categoryId } = req.body || {};
    if (!name || !slug || !categoryId) return res.status(400).json({ error: "missing_fields" });
    if (!mongoose.isValidObjectId(categoryId)) return res.status(400).json({ error: "invalid_category" });
    
    const exists = await SubCategory.findOne({ $or: [{ name }, { slug }], category: categoryId });
    if (exists) return res.status(409).json({ error: "duplicate_subcategory" });
    
    const doc = await SubCategory.create({ name, slug, category: categoryId });
    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create subcategory" });
  }
});

router.post("/brands", protect, async (req, res) => {
  try {
    const { name, slug, logo } = req.body || {};
    if (!name || !slug) return res.status(400).json({ error: "missing_fields" });
    
    const exists = await Brand.findOne({ $or: [{ name }, { slug }] });
    if (exists) return res.status(409).json({ error: "duplicate_brand" });
    
    const doc = await Brand.create({ name, slug, logo });
    await delCache("brands:all");
    await bumpCacheVersion("products:grouped");
    await bumpCacheVersion("products:list");
    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create brand" });
  }
});

export default router;
