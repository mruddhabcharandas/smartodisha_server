import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import Store from "../models/Store.js";
import StoreRequest from "../models/StoreRequest.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import { sendEmail } from "../lib/mailer.js";

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
    const { name, phone, address, gstNumber } = req.body;
    const store = await Store.findById(req.store._id);

    if (store) {
      store.name = name || store.name;
      store.phone = phone || store.phone;
      store.address = address || store.address;
      store.gstNumber = gstNumber || store.gstNumber;

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

// Get store orders
router.get("/orders", protect, async (req, res) => {
  try {
    // Find orders that have products from this store
    const orders = await Order.find({
      "items.product": {
        $in: await Product.find({ store: req.store._id }).distinct("_id")
      }
    }).sort({ createdAt: -1 });

    // Calculate store-specific revenue
    const ordersWithRevenue = orders.map(order => {
      const itemsFromStore = order.items.filter(item => {
        // We need to check if this item is from our store
        return true; // For now, assume all items in orders are relevant, we'll refine this later
      });

      let storeRevenue = 0;
      itemsFromStore.forEach(item => {
        const storePrice = item.originalStorePrice || item.price;
        const adminCut = (storePrice * req.store.adminCutPercentage) / 100;
        storeRevenue += (storePrice - adminCut) * item.quantity;
      });

      return {
        ...order.toObject(),
        storeRevenue
      };
    });

    res.json(ordersWithRevenue);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// Get dashboard stats
router.get("/dashboard", protect, async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments({ store: req.store._id });
    const activeProducts = await Product.countDocuments({ store: req.store._id, isActive: true });
    const outOfStock = await Product.countDocuments({ store: req.store._id, stock: 0 });

    // Get recent orders
    const recentOrders = await Order.find({
      "items.product": {
        $in: await Product.find({ store: req.store._id }).distinct("_id")
      }
    }).sort({ createdAt: -1 }).limit(10);

    // Calculate total revenue
    let totalRevenue = 0;
    for (const order of recentOrders) {
      for (const item of order.items) {
        const storePrice = item.originalStorePrice || item.price;
        const adminCut = (storePrice * req.store.adminCutPercentage) / 100;
        totalRevenue += (storePrice - adminCut) * item.quantity;
      }
    }

    res.json({
      totalProducts,
      activeProducts,
      outOfStock,
      totalRevenue,
      recentOrders
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

export default router;
