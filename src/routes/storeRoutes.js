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
    const { sendPasswordResetEmail } = await import("../lib/mailer.js");
    try {
      await sendPasswordResetEmail(store.email, store.name, resetUrl);
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

// Send OTP for password change
router.post("/send-otp", protect, async (req, res) => {
  try {
    const store = await Store.findById(req.store._id);
    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    store.otp = otp;
    store.otpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
    await store.save();

    // Send OTP via email (we can use sendEmail from mailer)
    try {
      const { sendEmail } = await import("../lib/mailer.js");
      await sendEmail(
        store.email,
        "Your OTP for Password Change",
        `<p>Dear ${store.name},</p>
         <p>Your OTP for password change is: <strong>${otp}</strong></p>
         <p>This OTP is valid for 10 minutes.</p>
         <p>If you didn't request this, please ignore this email.</p>`
      );
    } catch (emailErr) {
      console.error("Failed to send OTP email:", emailErr);
    }

    res.json({ message: "OTP sent successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// Change password
router.post("/change-password", protect, async (req, res) => {
  try {
    const { oldPassword, newPassword, otp } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: "New password is required" });
    }

    const store = await Store.findById(req.store._id);
    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    if (otp) {
      // Verify OTP
      if (store.otp !== otp || (store.otpExpires && store.otpExpires < Date.now())) {
        return res.status(401).json({ error: "Invalid or expired OTP" });
      }
      // Clear OTP
      store.otp = undefined;
      store.otpExpires = undefined;
    } else if (oldPassword) {
      // Verify old password
      const isMatch = await store.comparePassword(oldPassword);
      if (!isMatch) {
        return res.status(401).json({ error: "Old password is incorrect" });
      }
    } else {
      return res.status(400).json({ error: "Either old password or OTP is required" });
    }

    // Update password
    store.password = newPassword;
    await store.save();
    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to change password" });
  }
});

// Update store profile
router.put("/profile", protect, async (req, res) => {
  try {
    const { name, phone, address, gstNumber, pickupAddress, pickupName, pickupPhone, shiprocketEmail, shiprocketPassword, image, sellerAvatar, currentPassword } = req.body;
    const store = await Store.findById(req.store._id);

    // Check if pickup details are being changed
    const isPickupChanged = 
      (pickupAddress && JSON.stringify(pickupAddress) !== JSON.stringify(store.pickupAddress)) ||
      (pickupName && pickupName !== store.pickupName) ||
      (pickupPhone && pickupPhone !== store.pickupPhone);

    if (isPickupChanged) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Current password is required to update pickup details" });
      }
      const isMatch = await store.comparePassword(currentPassword);
      if (!isMatch) {
        return res.status(401).json({ error: "Invalid current password" });
      }
    }

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

// Create Delhivery shipment (seller)
router.post("/orders/:id/delhivery/create", protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  try {
    const order = await Order.findOne({ _id: req.params.id, store: req.store._id });
    if (!order) return res.status(404).json({ error: "order_not_found" });

    const Customer = (await import("../models/Customer.js")).default;
    const { createShipment, checkServiceability } = await import("../services/delhivery.service.js");

    let pickupPincode = req.store.pickupAddress?.pincode || process.env.DELHIVERY_PICKUP_PINCODE || "360001";
    let pickupName = req.store.pickupName || req.store.name || process.env.DELHIVERY_PICKUP_NAME || "Warehouse";
    let pickupAddressLine = `${req.store.pickupAddress?.line1 || ''} ${req.store.pickupAddress?.line2 || ''}`.trim() || process.env.DELHIVERY_PICKUP_ADDRESS || "Address";
    let pickupCity = req.store.pickupAddress?.city || process.env.DELHIVERY_PICKUP_CITY || "City";
    let pickupState = req.store.pickupAddress?.state || process.env.DELHIVERY_PICKUP_STATE || "State";
    let pickupPhone = req.store.pickupPhone || req.store.phone || process.env.DELHIVERY_PICKUP_PHONE || "9876543210";

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
      let productWeight = p?.weight || 0;
      
      if (it.variantId && p?.variants) {
        const variant = p.variants.find(v => v._id.toString() === it.variantId.toString());
        if (variant) {
          productWeight = variant.weight || productWeight;
        }
      }

      totalWeightGrams += (productWeight * it.quantity);

      // Use order item price, but fallback to lineTotal/qty when the stored unit price is clearly too low.
      const reportedUnitPrice = Number(it.price || p?.sellingPrice || 0);
      const fallbackUnitPrice = it.quantity ? Number((it.lineTotal / it.quantity).toFixed(2)) : reportedUnitPrice;
      const orderAmount = Number(order.totalEstimate || order.productTotal || 0);
      const useFallbackPrice = reportedUnitPrice > 0
        ? (reportedUnitPrice * it.quantity < orderAmount * 0.5 && orderAmount > 20)
        : true;
      const unitPrice = useFallbackPrice ? fallbackUnitPrice : reportedUnitPrice;
      
      return {
        name: it.name,
        sku: it.variantSku || p?.sku || it.product.toString(),
        qty: it.quantity,
        selling_price: Number(unitPrice),
        discount: Number(it.discountPerUnit || 0),
        tax: Number(p?.gst || 0),
        hsn: String(p?.hsnCode || "9999")
      };
    });

    const weightKg = Math.max(totalWeightGrams / 1000, 0.05);
    const cleanPhone = String(order.customer.phone || "").replace(/\D/g, "").slice(-10);

    // Helper to sanitize strings (trim, remove extra spaces)
    const sanitize = (s) => String(s || "").trim();

    const shipmentData = {
      format: "json",
      data: {
        shipments: [
          {
            add: sanitize(addr.line1),
            address2: sanitize(addr.line2),
            city: sanitize(addr.city),
            country: "India",
            name: sanitize(order.customer.name),
            phone: cleanPhone,
            pin: sanitize(addr.pincode),
            state: sanitize(addr.state),
            order: order._id.toString(),
            payment_mode: order.paymentMethod === "COD" ? "COD" : "Prepaid",
            shipping_mode: "Surface",
            return_name: sanitize(pickupName),
            return_address: sanitize(pickupAddressLine),
            return_city: sanitize(pickupCity),
            return_pin: sanitize(pickupPincode),
            return_state: sanitize(pickupState),
            return_phone: sanitize(pickupPhone),
            products_desc: sanitize(orderItems.map(i => i.name).join(", ")),
            order_date: new Date().toISOString().split("T")[0],
            // Use product total + shipping cost, not the full totalEstimate that includes COD surcharge
            total_amount: Number((order.productTotal || 0) + (order.shippingCost || 0)),
            seller_name: sanitize(pickupName),
            seller_add: sanitize(pickupAddressLine),
            seller_city: sanitize(pickupCity),
            seller_pin: sanitize(pickupPincode),
            seller_state: sanitize(pickupState),
            seller_phone: sanitize(pickupPhone),
            seller_gst_tin: sanitize(req.store.gstNumber),
            ewaybill_no: "",
            ewaybill_date: "",
            ewaybill_validity: "",
            ewaybill_value: 0,
            // Add weight (required by Delhivery)
            weight: Number(weightKg.toFixed(2)),
            products: orderItems.map(item => ({
              ...item,
              name: sanitize(item.name),
              sku: sanitize(item.sku),
              qty: Number(item.qty),
              selling_price: Number(item.selling_price),
              discount: Number(item.discount),
              tax: Number(item.tax),
              hsn: sanitize(item.hsn)
            }))
          }
        ]
      }
    };

    if (order.paymentMethod === "COD") {
      const productTotal = Number(order.productTotal || 0);
      const shippingCharge = Number(order.shippingCost || 0);
      const totalAmount = productTotal + shippingCharge;
      const advanceAmount = Math.ceil(totalAmount * 0.15);
      const codDueAmount = Number((totalAmount - advanceAmount).toFixed(2));
      shipmentData.data.shipments[0].cod_amount = codDueAmount;
      shipmentData.data.shipments[0].total_amount = totalAmount;
    }

    console.log("Sending to Delhivery:", JSON.stringify(shipmentData, null, 2));
    const result = await createShipment(shipmentData);
    console.log("Delhivery response:", result);

    const waybill = result?.packages?.[0]?.waybill || result?.shipments?.[0]?.waybill || '';
    
    if (waybill) {
      const trackingUrl = `https://www.delhivery.com/track/package/${waybill}`;
      order.shipping = { provider: "DELHIVERY", waybill, status: "CREATED", trackingUrl };
      order.shippingAddress = addr;
      order.status = "SHIPPED";
      await order.save();

      await AuditLog.create({
        actorId: req.store._id,
        actorRole: "store",
        type: "ORDER_STATUS",
        entityType: "ORDER",
        entityId: order._id.toString(),
        note: `Delhivery shipment created. Waybill: ${waybill}`
      });

      return res.json({ success: true, waybill, trackingUrl, status: order.status });
    }

    return res.status(400).json({ error: "shipment_creation_failed", message: "Failed to generate waybill from Delhivery.", details: result });
  } catch (err) {
    console.error("Seller Delhivery create failed:", err.message || err);
    res.status(502).json({ error: "shipment_creation_failed", message: err.message });
  }
});

// Download Delhivery PDF Label (seller)
router.get("/orders/:id/delhivery/label/:waybill", protect, async (req, res) => {
  const waybill = req.params.waybill;
  try {
    const order = await Order.findOne({ _id: req.params.id, store: req.store._id });
    if (!order) return res.status(404).json({ error: "order_not_found" });

    const { generateLabel } = await import("../services/delhivery.service.js");
    const labelResult = await generateLabel([waybill]);

    // If Delhivery returns label, use it!
    if (labelResult.pdfBuffer || labelResult.pdfUrl) {
      if (labelResult.pdfBuffer) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename=label_${waybill}.pdf`);
        return res.send(labelResult.pdfBuffer);
      } else {
        const axios = await import("axios");
        const pdfResponse = await axios.default.get(labelResult.pdfUrl, { responseType: "arraybuffer" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename=label_${waybill}.pdf`);
        return res.send(Buffer.from(pdfResponse.data));
      }
    }

    // Fallback to custom PDF
    const PDFDocument = (await import("pdfkit")).default;
    const doc = new PDFDocument({ margin: 24, size: "A6" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=label_${waybill}.pdf`);
    doc.pipe(res);
    
    doc.fontSize(18).text("SHIPPING LABEL", { align: "center", underline: true });
    doc.moveDown(0.5);
    if (waybill) {
      doc.fontSize(14).text(`Waybill: ${waybill}`, { align: "center" });
      doc.moveDown(0.5);
    }

    // Customer Info
    doc.fontSize(12).text("SHIP TO:", { underline: true });
    doc.fontSize(10);
    doc.text(`Name: ${order.customer?.name || ""}`);
    doc.text(`Phone: ${order.customer?.phone || ""}`);
    const a = order.shippingAddress || {};
    const addressParts = [a.line1, a.line2].filter(Boolean);
    if (addressParts.length) doc.text(addressParts.join(", "));
    const cityState = [a.city, a.state, a.pincode].filter(Boolean).join(", ");
    if (cityState) doc.text(cityState);
    
    doc.moveDown(0.5);

    // Items (simple list)
    doc.fontSize(12).text("ITEMS:", { underline: true });
    doc.fontSize(9);
    (order.items || []).forEach((item, idx) => {
      const sku = item.variantSku || item.sku || "N/A";
      doc.text(`${idx + 1}. ${item.name} (SKU: ${sku}) x ${item.quantity}`);
    });

    doc.moveDown(0.5);
    doc.fontSize(12).text(`Order Amount: ₹${Number(order.totalEstimate || 0).toLocaleString("en-IN")}`, { align: "right" });
    
    doc.end();
  } catch (err) {
    console.error("Seller shiprocket label failed:", err.response?.data || err.message);
    // Fallback to custom PDF if Shiprocket fails (simple shipping label only)
    try {
      const order = await Order.findOne({ _id: req.params.id, store: req.store._id }).lean();
      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({ margin: 24, size: "A6" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=label_${awb}.pdf`);
      doc.pipe(res);
      
      doc.fontSize(18).text("SHIPPING LABEL", { align: "center", underline: true });
      doc.moveDown(0.5);
      if (awb) {
        doc.fontSize(14).text(`AWB: ${awb}`, { align: "center" });
        doc.moveDown(0.5);
      }

      // Customer Info
      doc.fontSize(12).text("SHIP TO:", { underline: true });
      doc.fontSize(10);
      doc.text(`Name: ${order.customer?.name || ""}`);
      doc.text(`Phone: ${order.customer?.phone || ""}`);
      const a = order.shippingAddress || {};
      const addressParts = [a.line1, a.line2].filter(Boolean);
      if (addressParts.length) doc.text(addressParts.join(", "));
      const cityState = [a.city, a.state, a.pincode].filter(Boolean).join(", ");
      if (cityState) doc.text(cityState);
      
      doc.moveDown(0.5);

      // Items (simple list)
      doc.fontSize(12).text("ITEMS:", { underline: true });
      doc.fontSize(9);
      (order.items || []).forEach((item, idx) => {
        const sku = item.variantSku || item.sku || "N/A";
        doc.text(`${idx + 1}. ${item.name} (SKU: ${sku}) x ${item.quantity}`);
      });

      doc.moveDown(0.5);
      doc.fontSize(12).text(`Order Amount: ₹${Number(order.totalEstimate || 0).toLocaleString("en-IN")}`, { align: "right" });
      
      doc.end();
    } catch (fallbackErr) {
      res.status(500).json({ error: "label_generation_failed", message: fallbackErr.message });
    }
  }
});

// Get dashboard stats
router.get("/dashboard", protect, async (req, res) => {
  try {
    const storeId = req.store._id;
    const totalProducts = await Product.countDocuments({ store: storeId });
    const activeProducts = await Product.countDocuments({ store: storeId, isActive: true });
    const outOfStock = await Product.countDocuments({ store: storeId, stock: 0 });

    // Get recent orders
    const recentOrders = await Order.find({ store: storeId }).sort({ createdAt: -1 }).limit(10);

    // Calculate total revenue
    const totalRevenue = await Order.aggregate([
      { $match: { store: storeId } },
      { $group: { _id: null, total: { $sum: "$storeRevenue" } } }
    ]);

    // Calculate pending and received revenue
    const revenueBreakdown = await Order.aggregate([
      { $match: { store: storeId } },
      { $group: { 
        _id: null, 
        pending: { 
          $sum: { $cond: [ { $in: [ "$status", ["NEW", "PACKED", "PENDING_PAYMENT"] ] }, "$storeRevenue", 0 ] }
        },
        received: { 
          $sum: { $cond: [ { $in: [ "$status", ["DELIVERED", "FULFILLED"] ] }, "$storeRevenue", 0 ] }
        },
        totalRevenue: { $sum: "$storeRevenue" }
      } }
    ]);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Monthly revenue breakdown
    const monthlyRevenue = await Order.aggregate([
      { $match: { store: storeId, createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$storeRevenue" }, count: { $sum: 1 } } }
    ]);

    // Top products for this store
    const topProducts = await Order.aggregate([
      { $match: { store: storeId, status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] } } },
      { $unwind: "$items" },
      { $group: { _id: "$items.product", name: { $first: "$items.name" }, revenue: { $sum: "$items.lineTotal" }, quantity: { $sum: "$items.quantity" } } },
      { $sort: { revenue: -1 } },
      { $limit: 5 }
    ]);

    // Order status breakdown
    const orderStatusBreakdown = await Order.aggregate([
      { $match: { store: storeId } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);

    // Format the status breakdown into an object
    const statusCount = {};
    orderStatusBreakdown.forEach(item => statusCount[item._id] = item.count);

    res.json({
      totalProducts,
      activeProducts,
      outOfStock,
      totalRevenue: totalRevenue[0]?.total || 0,
      pendingRevenue: revenueBreakdown[0]?.pending || 0,
      receivedRevenue: revenueBreakdown[0]?.received || 0,
      thisMonthRevenue: monthlyRevenue[0]?.total || 0,
      thisMonthOrders: monthlyRevenue[0]?.count || 0,
      recentOrders,
      topProducts,
      orderStatus: statusCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

// Store products CRUD
router.post("/products", protect, async (req, res) => {
  try {
    const { name, price, categoryId, subCategoryId, images, stock, weight, length, width, height, gst, description, highlights, specifications, bulkDiscountQuantity, bulkDiscountPriceReduction, mrp, bulkTiers, variants, brandId, minOrderQty, section, hsnCode, sku, packSize } = req.body || {};
    if (!name || price == null || stock == null || !categoryId) return res.status(400).json({ error: "missing_fields" });
    
    if (brandId && !mongoose.isValidObjectId(brandId)) return res.status(400).json({ error: "invalid_brand" });
    if (!mongoose.isValidObjectId(categoryId)) return res.status(400).json({ error: "invalid_category" });
    if (subCategoryId && !mongoose.isValidObjectId(subCategoryId)) return res.status(400).json({ error: "invalid_subcategory" });

    const storePercentage = req.store.storePercentage || 0;
    
    // Validate main product price and MRP gap
    if (mrp !== undefined && mrp !== null && Number(mrp) > 0) {
      const requiredGap = Number(price) * (storePercentage / 100);
      if (Number(mrp) - Number(price) < requiredGap - 0.01) { // Small epsilon for floating point errors
        return res.status(400).json({
          error: "mrp_insufficient_gap",
          message: `MRP must be at least ${storePercentage}% higher than price. Current gap is ₹${(Number(mrp) - Number(price)).toFixed(2)}, required gap is ₹${requiredGap.toFixed(2)}`
        });
      }
    }

    // Validate variants price and MRP gaps
    if (Array.isArray(variants) && variants.length > 0) {
      for (const v of variants) {
        if (v.mrp !== undefined && v.mrp !== null && Number(v.mrp) > 0) {
          const variantPrice = Number(v?.price ?? price);
          const requiredGap = variantPrice * (storePercentage / 100);
          if (Number(v.mrp) - variantPrice < requiredGap - 0.01) {
            return res.status(400).json({
              error: "variant_mrp_insufficient_gap",
              message: `Variant MRP must be at least ${storePercentage}% higher than variant price.`
            });
          }
        }
      }
    }

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
      length: Number(length || 0),
      width: Number(width || 0),
      height: Number(height || 0),
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
          length: Number(v?.length ?? length ?? 0),
          width: Number(v?.width ?? width ?? 0),
          height: Number(v?.height ?? height ?? 0),
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

    const allowed = ["name", "description", "highlights", "specifications", "price", "categoryId", "subCategoryId", "images", "stock", "weight", "length", "width", "height", "gst", "mrp", "isActive", "bulkDiscountQuantity", "bulkDiscountPriceReduction", "bulkTiers", "variants", "brandId", "minOrderQty", "section", "hsnCode", "sku", "packSize"];
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
          length: Number(v?.length ?? 0),
          width: Number(v?.width ?? 0),
          height: Number(v?.height ?? 0),
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

    const storePercentage = req.store.storePercentage || 0;
    
    // Validate main product price and MRP gap
    const currentPrice = payload.price !== undefined ? Number(payload.price) : Number(beforeDoc.price);
    const currentMrp = payload.mrp !== undefined 
      ? (payload.mrp == null || payload.mrp === "" ? undefined : Number(payload.mrp)) 
      : (beforeDoc.mrp ? Number(beforeDoc.mrp) : undefined);
    if (currentMrp !== undefined && currentMrp > 0) {
      const requiredGap = currentPrice * (storePercentage / 100);
      if (currentMrp - currentPrice < requiredGap - 0.01) {
        return res.status(400).json({
          error: "mrp_insufficient_gap",
          message: `MRP must be at least ${storePercentage}% higher than price.`
        });
      }
    }

    // Validate variants price and MRP gaps
    if (Array.isArray(payload.variants) && payload.variants.length > 0) {
      for (const v of payload.variants) {
        const variantPrice = Number(v.price ?? 0);
        const variantMrp = v.mrp !== undefined && v.mrp !== null ? Number(v.mrp) : undefined;
        if (variantMrp !== undefined && variantMrp > 0) {
          const requiredGap = variantPrice * (storePercentage / 100);
          if (variantMrp - variantPrice < requiredGap - 0.01) {
            return res.status(400).json({
              error: "variant_mrp_insufficient_gap",
              message: `Variant MRP must be at least ${storePercentage}% higher than variant price.`
            });
          }
        }
      }
    }

    if (payload.price != null && beforeDoc) {
      const newPrice = Number(payload.price);
      const oldPrice = Number(beforeDoc.price);
      const mrp = currentMrp !== undefined ? currentMrp : (beforeDoc.mrp ? Number(beforeDoc.mrp) : newPrice);
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
