import express from "express";
import mongoose from "mongoose";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import Product from "../models/Product.js";
import Customer from "../models/Customer.js";
import Bill from "../models/Bill.js";
import Store from "../models/Store.js";
import { sendEmail } from "../lib/mailer.js";
import { bumpCacheVersion, delCache } from "../lib/redis.js";

import Admin from "../models/Admin.js";
import SystemSetting from "../models/SystemSetting.js";

const router = express.Router();

// Store Admin Routes
// Get all stores
router.get("/stores", auth, requireRole("admin"), async (req, res) => {
  try {
    const stores = await Store.find().sort({ createdAt: -1 }).select("-password");
    res.json(stores);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stores" });
  }
});

// Get single store by ID
router.get("/stores/:id", auth, requireRole("admin"), async (req, res) => {
  try {
    const store = await Store.findById(req.params.id).select("-password");
    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }
    res.json(store);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch store" });
  }
});

// Create new store
router.post("/stores", auth, requireRole("admin"), async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phone,
      address,
      gstNumber,
      gstPercentage,
      image,
      storePercentage,
      adminCutPercentage,
      isActive,
      isPopular
    } = req.body;

    // Validate required fields
    if (!name || !email || !password || !phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if store exists with same email
    const existingStore = await Store.findOne({ email });
    if (existingStore) {
      return res.status(400).json({ error: "Store with this email already exists" });
    }

    const store = await Store.create({
      name,
      email,
      password,
      phone,
      address,
      gstNumber,
      gstPercentage,
      image,
      storePercentage,
      adminCutPercentage,
      isActive,
      isPopular
    });

    // Send greeting email to store owner
    const { sendSellerGreeting } = await import("../lib/mailer.js");
    try {
      await sendSellerGreeting(store.email, store.name);
    } catch (err) {
      console.error("Failed to send welcome email to store:", err);
    }

    // Invalidate store cache
    await bumpCacheVersion("stores");
    await delCache("stores:all:*");

    const storeObj = store.toObject();
    delete storeObj.password;
    res.status(201).json(storeObj);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create store" });
  }
});

// Update store
router.put("/stores/:id", auth, requireRole("admin"), async (req, res) => {
  try {
    const store = await Store.findById(req.params.id);
    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    const {
      name,
      email,
      password,
      phone,
      address,
      gstNumber,
      gstPercentage,
      image,
      storePercentage,
      adminCutPercentage,
      isActive,
      isPopular
    } = req.body;

    if (name) store.name = name;
    if (email) store.email = email;
    if (password) store.password = password;
    if (phone) store.phone = phone;
    if (address) store.address = address;
    if (gstNumber !== undefined) store.gstNumber = gstNumber;
    if (gstPercentage !== undefined) store.gstPercentage = gstPercentage;
    if (image !== undefined) store.image = image;
    if (storePercentage !== undefined) store.storePercentage = storePercentage;
    if (adminCutPercentage !== undefined) store.adminCutPercentage = adminCutPercentage;
    if (isActive !== undefined) store.isActive = isActive;
    if (isPopular !== undefined) store.isPopular = isPopular;

    await store.save();

    // Invalidate store cache
    await bumpCacheVersion("stores");
    await delCache("stores:all:*");

    const storeObj = store.toObject();
    delete storeObj.password;
    res.json(storeObj);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update store" });
  }
});

// Delete store
router.delete("/stores/:id", auth, requireRole("admin"), async (req, res) => {
  try {
    const store = await Store.findByIdAndDelete(req.params.id);
    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    // Invalidate store cache
    await bumpCacheVersion("stores");
    await delCache("stores:all:*");

    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete store" });
  }
});

// Get all staff members
router.get("/staff", auth, requireRole("admin"), async (req, res) => {
  const staff = await Admin.find({ role: "staff" }).select("-password");
  res.json(staff);
});

// Create new staff
router.post("/staff", auth, requireRole("admin"), async (req, res) => {
  const { name, email, password, permissions } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "missing_fields" });
  
  const exists = await Admin.findOne({ email: email.toLowerCase() });
  if (exists) return res.status(400).json({ error: "email_exists" });

  const staff = await Admin.create({
    name,
    email: email.toLowerCase(),
    password,
    role: "staff",
    permissions: permissions || [],
    isActive: true
  });

  const staffObj = staff.toObject();
  delete staffObj.password;
  res.status(201).json(staffObj);
});

// Update staff permissions/status
router.put("/staff/:id", auth, requireRole("admin"), async (req, res) => {
  const { name, permissions, isActive, password } = req.body || {};
  const staff = await Admin.findById(req.params.id);
  if (!staff) return res.status(404).json({ error: "not_found" });

  if (name) staff.name = name;
  if (permissions) staff.permissions = permissions;
  if (isActive !== undefined) staff.isActive = isActive;
  if (password) staff.password = password;

  await staff.save();
  const staffObj = staff.toObject();
  delete staffObj.password;
  res.json(staffObj);
});

// Delete staff
router.delete("/staff/:id", auth, requireRole("admin"), async (req, res) => {
  await Admin.findByIdAndDelete(req.params.id);
  res.json({ deleted: true });
});

router.get("/stats", auth, async (req, res) => {
  const Order = (await import("../models/Order.js")).default;
  const threshold = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);
  
  // Aggregate inventory stats directly in DB for efficiency
  const invStats = await Product.aggregate([
    { $match: { isActive: true } },
    {
      $project: {
        skus: {
          $cond: {
            if: { $and: [{ $isArray: "$variants" }, { $gt: [{ $size: "$variants" }, 0] }] },
            then: {
              $filter: {
                input: "$variants",
                as: "v",
                cond: { $ne: ["$$v.isActive", false] }
              }
            },
            else: [{ stock: "$stock", isActive: true }]
          }
        }
      }
    },
    { $unwind: "$skus" },
    {
      $group: {
        _id: null,
        totalSkus: { $sum: 1 },
        totalUnits: { $sum: "$skus.stock" },
        outOfStock: { $sum: { $cond: [{ $eq: ["$skus.stock", 0] }, 1, 0] } },
        lowStockCount: { $sum: { $cond: [{ $and: [{ $gt: ["$skus.stock", 0] }, { $lte: ["$skus.stock", threshold] }] }, 1, 0] } }
      }
    }
  ]);

  const [actualProductsCount, totalCustomers, pendingCustomers, totalBills, totalSellers, lowStockProducts, newOrders, pendingCash] = await Promise.all([
    Product.countDocuments({ isActive: true }),
    Customer.countDocuments({ isActive: true }),
    Customer.countDocuments({ isActive: false }),
    Bill.countDocuments({}),
    Store.countDocuments({}), // Add total sellers count
    Product.find({ 
      isActive: true, 
      $or: [
        { variants: { $exists: true, $not: { $size: 0 } }, "variants.stock": { $lte: threshold } },
        { variants: { $exists: false }, stock: { $lte: threshold } },
        { variants: { $size: 0 }, stock: { $lte: threshold } }
      ]
    })
      .sort({ stock: 1 })
      .limit(20),
    Order.countDocuments({ status: "NEW" }),
    Order.countDocuments({ status: "PENDING_ADMIN_APPROVAL" })
  ]);

  const inv = invStats[0] || { totalSkus: 0, totalUnits: 0, outOfStock: 0, lowStockCount: 0 };

  // Flatten low stock to SKU level
  const lowStock = [];
  lowStockProducts.forEach(p => {
    if (p.variants && p.variants.length > 0) {
      p.variants.forEach(v => {
        if (v.isActive !== false && v.stock <= threshold) {
          lowStock.push({
            _id: `${p._id}_${v.sku}`,
            productId: p._id,
            name: `${p.name} (${v.sku || 'No SKU'})`,
            stock: v.stock,
            isVariant: true,
            sku: v.sku
          });
        }
      });
    } else if (p.stock <= threshold) {
      lowStock.push({
        _id: p._id,
        productId: p._id,
        name: p.name,
        stock: p.stock,
        isVariant: false
      });
    }
  });

  res.json({ 
    actualProductsCount,
    totalProducts: inv.totalSkus, 
    totalUnits: inv.totalUnits,
    outOfStock: inv.outOfStock,
    lowStockCount: inv.lowStockCount,
    totalCustomers, 
    pendingCustomers, 
    totalBills, 
    totalSellers, // Add to response
    lowStock: lowStock.sort((a, b) => a.stock - b.stock).slice(0, 10), 
    newOrders, 
    pendingCash 
  });
});

router.get("/settings", auth, requireRole("admin"), async (req, res) => {
  try {
    const settings = await SystemSetting.findOne();
    res.json({
      companyName: process.env.COMPANY_NAME || "Click2Kart",
      companyGst: process.env.COMPANY_GST || "",
      companyAddress: process.env.COMPANY_ADDRESS || "",
      companyPhone: process.env.COMPANY_PHONE || "",
      companyEmail: process.env.COMPANY_EMAIL || "",
      lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD ?? 5),
      freeDeliveryAbove: settings?.freeDeliveryAbove ?? Number(process.env.FREE_DELIVERY_ABOVE || 999)
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.put("/settings", auth, requireRole("admin"), async (req, res) => {
  try {
    const { freeDeliveryAbove } = req.body;
    if (freeDeliveryAbove === undefined || isNaN(Number(freeDeliveryAbove))) {
      return res.status(400).json({ error: "Invalid freeDeliveryAbove value" });
    }

    let settings = await SystemSetting.findOne();
    if (!settings) {
      settings = new SystemSetting();
    }

    settings.freeDeliveryAbove = Number(freeDeliveryAbove);
    await settings.save();

    res.json({
      success: true,
      freeDeliveryAbove: settings.freeDeliveryAbove
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to update settings" });
  }
});

router.get("/customers", auth, requirePermission("customers"), async (req, res) => {
  const { q } = req.query;
  const filter = {};
  if (q) {
    filter.$or = [
      { name: { $regex: String(q), $options: "i" } },
      { phone: { $regex: String(q), $options: "i" } }
    ];
  }
  const items = await Customer.find(filter).sort({ createdAt: -1 }).lean();
  
  const Order = (await import("../models/Order.js")).default;
  const itemsWithOrderCount = await Promise.all(
    items.map(async (c) => {
      const orderCount = await Order.countDocuments({ "customer.phone": c.phone });
      return { ...c, orderCount };
    })
  );
  
  res.json(itemsWithOrderCount);
});

router.get("/customers/:id", auth, requirePermission("customers"), async (req, res) => {
  const id = req.params.id;
  const user = await Customer.findById(id).select("-password");
  if (!user) return res.status(404).json({ error: "not_found" });
  const Order = (await import("../models/Order.js")).default;
  const Bill = (await import("../models/Bill.js")).default;
  const orders = await Order.find({ "customer.phone": user.phone }).sort({ createdAt: -1 }).limit(10);
  const bills = await Bill.find({ customer: id }).sort({ createdAt: -1 }).limit(10);
  res.json({ user, orders, bills });
});

router.delete("/customers/:id", auth, requireRole("admin"), async (req, res) => {
  const id = req.params.id;
  const removed = await Customer.findByIdAndDelete(id);
  if (!removed) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

router.post("/customers/:id/approve", auth, requirePermission("customers"), async (req, res) => {
  const id = req.params.id;
  const updated = await Customer.findByIdAndUpdate(id, { isActive: true }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  if (updated.email) {
    try {
      const loginUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/login`;
      await sendEmail({
        to: updated.email,
        subject: `Account Approved - ${process.env.COMPANY_NAME || "SmartOdisha"}`,
        html: renderMail({
          heading: "Account Approved!",
          subheading: `Hi ${updated.name}, your account has been approved. You can now log in and start shopping.`,
          blocks: [
            { label: "Account Status", value: "Active" },
            { label: "Email", value: updated.email }
          ],
          highlight: `<a href="${loginUrl}" style="color:inherit;text-decoration:none">Click here to Login</a>`
        })
      });
    } catch (err) {
      console.error("Failed to send customer approval email:", err);
    }
  }
  res.json({ approved: true, customer: updated });
});

// Top buyers analytics
router.get("/analytics/top-buyers", auth, requireRole("admin"), async (req, res) => {
  const Order = (await import("../models/Order.js")).default;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const agg = await Order.aggregate([
    {
      $group: {
        _id: "$customer.phone",
        name: { $last: "$customer.name" },
        email: { $last: "$customer.email" },
        totalSpent: { $sum: "$totalEstimate" },
        orderCount: { $sum: 1 }
      }
    },
    { $sort: { totalSpent: -1 } },
    { $limit: limit }
  ]);
  res.json(agg.map(x => ({
    phone: x._id,
    name: x.name || "",
    email: x.email || "",
    totalSpent: x.totalSpent || 0,
    orderCount: x.orderCount || 0
  })));
});

// Revenue and Top Products Summary
router.get("/revenue/summary", auth, requireRole("admin"), async (req, res) => {
  const Order = (await import("../models/Order.js")).default;
  try {
    const totalAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] } } },
      { $group: { _id: null, total: { $sum: "$totalEstimate" }, count: { $sum: 1 }, adminRevenue: { $sum: "$adminRevenue" } } }
    ]);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] }, createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$totalEstimate" }, adminRevenue: { $sum: "$adminRevenue" } } }
    ]);

    const pendingCount = await Order.countDocuments({ status: "NEW" });

    // Top Products Aggregation (PRODUCT-BASED - User requested)
    const topProductsAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.product",
          name: { $first: "$items.name" },
          revenue: { $sum: "$items.lineTotal" },
          quantity: { $sum: "$items.quantity" }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 }
    ]);

    const topBuyersAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] } } },
      {
        $group: {
          _id: "$customer.phone",
          name: { $first: "$customer.name" },
          phone: { $first: "$customer.phone" },
          total: { $sum: "$totalEstimate" }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 5 }
    ]);

    res.json({
      totalRevenue: totalAgg[0]?.total || 0,
      totalAdminRevenue: totalAgg[0]?.adminRevenue || 0,
      totalOrders: totalAgg[0]?.count || 0,
      thisMonthRevenue: monthAgg[0]?.total || 0,
      thisMonthAdminRevenue: monthAgg[0]?.adminRevenue || 0,
      pendingOrders: pendingCount,
      topProducts: topProductsAgg.map(p => ({
        id: p._id,
        name: p.name,
        revenue: p.revenue,
        quantity: p.quantity
      })),
      topBuyers: topBuyersAgg
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SKU Breakdown for a specific Product
router.get("/revenue/product/:id/skus", auth, requireRole("admin"), async (req, res) => {
  const Order = (await import("../models/Order.js")).default;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  
  try {
    const skuAgg = await Order.aggregate([
      { $match: { status: { $nin: ["CANCELLED", "PENDING_PAYMENT"] } } },
      { $unwind: "$items" },
      { $match: { "items.product": new mongoose.Types.ObjectId(req.params.id) } },
      {
        $group: {
          _id: "$items.variantSku",
          name: { $first: "$items.name" },
          revenue: { $sum: "$items.lineTotal" },
          quantity: { $sum: "$items.quantity" }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 }
    ]);

    res.json({
      productId: req.params.id,
      skus: skuAgg.map(s => ({
        sku: s._id || "No SKU",
        revenue: s.revenue,
        quantity: s.quantity
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hero Slides Management
router.get("/hero-slides", auth, requireRole("admin"), async (req, res) => {
  try {
    const HeroSlide = (await import("../models/HeroSlide.js")).default;
    const slides = await HeroSlide.find().sort({ createdAt: -1 });
    res.json(slides);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch hero slides" });
  }
});

router.post("/hero-slides", auth, requireRole("admin"), async (req, res) => {
  try {
    const { title, link, image } = req.body || {};
    if (!image || !image.url || !image.publicId) {
      return res.status(400).json({ error: "Image details (url, publicId) are required" });
    }
    const HeroSlide = (await import("../models/HeroSlide.js")).default;
    const slide = await HeroSlide.create({
      title: title || "",
      link: link || "",
      image: {
        url: image.url,
        publicId: image.publicId
      }
    });
    res.status(201).json(slide);
  } catch (err) {
    console.error("Create hero slide failed:", err);
    res.status(500).json({ error: "Failed to create hero slide" });
  }
});

router.delete("/hero-slides/:id", auth, requireRole("admin"), async (req, res) => {
  try {
    const HeroSlide = (await import("../models/HeroSlide.js")).default;
    const { deleteFile } = await import("../lib/s3.js");

    const slide = await HeroSlide.findById(req.params.id);
    if (!slide) return res.status(404).json({ error: "Hero slide not found" });

    if (slide.image?.publicId) {
      try {
        await deleteFile(slide.image.publicId);
        console.log("Deleted slide image from storage:", slide.image.publicId);
      } catch (storageErr) {
        console.error("Failed to delete slide from storage:", storageErr);
      }
    }

    await HeroSlide.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Hero slide deleted successfully" });
  } catch (err) {
    console.error("Delete hero slide failed:", err);
    res.status(500).json({ error: "Failed to delete hero slide" });
  }
});

// Get all store requests
router.get("/store-requests", auth, requireRole("admin"), async (req, res) => {
  try {
    const StoreRequest = (await import("../models/StoreRequest.js")).default;
    const requests = await StoreRequest.find().sort({ createdAt: -1 });
    res.json(requests);
  } catch (err) {
    console.error("Failed to fetch store requests:", err);
    res.status(500).json({ error: "Failed to fetch store requests" });
  }
});

// Reject a store request
router.post("/store-requests/:id/reject", auth, requireRole("admin"), async (req, res) => {
  try {
    const StoreRequest = (await import("../models/StoreRequest.js")).default;
    const request = await StoreRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    
    request.status = "rejected";
    await request.save();
    res.json({ message: "Request rejected successfully", request });
  } catch (err) {
    console.error("Failed to reject request:", err);
    res.status(500).json({ error: "Failed to reject request" });
  }
});

// Approve a store request
router.post("/store-requests/:id/approve", auth, requireRole("admin"), async (req, res) => {
  try {
    const crypto = await import("crypto");
    const StoreRequest = (await import("../models/StoreRequest.js")).default;
    const { sendEmail } = await import("../lib/mailer.js");

    const request = await StoreRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found" });

    // Check if store with this email already exists
    const existingStore = await Store.findOne({ email: request.email });
    if (existingStore) {
      return res.status(400).json({ error: "Store with this email already exists" });
    }

    // Generate random 10-char password
    const plainPassword = crypto.randomBytes(5).toString("hex");

    // Create store
    const store = await Store.create({
      name: request.businessName,
      email: request.email,
      phone: request.phone,
      password: plainPassword,
      address: request.address,
      isActive: true
    });

    // Mark request as approved
    request.status = "approved";
    await request.save();

    // Send email with credentials
    const subject = `Your Store has been approved - ${process.env.COMPANY_NAME || "SmartOdisha"}`;
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:20px auto;padding:40px;border:1px solid #f1f5f9;border-radius:24px;background:#ffffff;box-shadow:0 20px 40px rgba(0,0,0,0.03)">
        <div style="text-align:center;margin-bottom:32px">
          <img src="${process.env.LOGO_URL || 'https://smartodisha.in/logo.png'}" alt="SmartOdisha" style="height:50px;margin-bottom:16px;">
          <br>
          <div style="font-size:12px;letter-spacing:.3em;color:#7c3aed;background:#f5f3ff;border:1px solid #e9d5ff;display:inline-block;padding:8px 20px;border-radius:100px;font-weight:900;text-transform:uppercase">${process.env.COMPANY_NAME || "SmartOdisha"}</div>
        </div>
        <h1 style="color:#0f172a;margin:0 0 20px;font-weight:900;font-size:28px;text-align:center">Congratulations, ${request.name}!</h1>
        <p style="color:#64748b;line-height:1.6;font-size:16px;margin-bottom:24px">
          Your store request has been approved and is now live on <strong>SmartOdisha</strong>. We are thrilled to have you on board!
        </p>
        <div style="background:#f8fafc;padding:24px;border-radius:16px;border:1px solid #f1f5f9;margin-bottom:32px">
          <h3 style="color:#0f172a;margin-top:0">Login Credentials:</h3>
          <p style="color:#475569;margin:8px 0;"><strong>Email:</strong> ${request.email}</p>
          <p style="color:#475569;margin:8px 0;"><strong>Temporary Password:</strong> ${plainPassword}</p>
        </div>
        <div style="text-align:center">
          <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/business/login" style="background:#7c3aed;color:#ffffff;padding:16px 32px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;box-shadow:0 8px 16px rgba(124,58,237,0.2)">Go to Seller Login</a>
        </div>
      </div>
    `;
    
    try {
      await sendEmail({ to: request.email, subject, html });
    } catch (mailErr) {
      console.error("Failed to send approval email:", mailErr);
    }

    // Invalidate store cache
    await bumpCacheVersion("stores");
    await delCache("stores:all:*");

    res.json({ message: "Request approved and store created", store, request });
  } catch (err) {
    console.error("Failed to approve request:", err);
    res.status(500).json({ error: err.message || "Failed to approve request" });
  }
});

// Delete a store request
router.delete("/store-requests/:id", auth, requireRole("admin"), async (req, res) => {
  try {
    const StoreRequest = (await import("../models/StoreRequest.js")).default;
    const request = await StoreRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found" });

    await StoreRequest.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Request deleted successfully" });
  } catch (err) {
    console.error("Failed to delete request:", err);
    res.status(500).json({ error: "Failed to delete request" });
  }
});

// Change Admin/Staff Password
router.put("/change-password", auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current password and new password are required" });
    }

    const Admin = (await import("../models/Admin.js")).default;
    const adminUser = await Admin.findById(req.user.id);
    if (!adminUser) return res.status(404).json({ error: "Admin/Staff user not found" });

    // Validate current password
    const isMatch = await adminUser.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid current password" });
    }

    // Set new password (the schema will hash it on save)
    adminUser.password = newPassword;
    await adminUser.save();

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Admin password change failed:", err);
    res.status(500).json({ error: "Failed to update password" });
  }
});

export default router;
