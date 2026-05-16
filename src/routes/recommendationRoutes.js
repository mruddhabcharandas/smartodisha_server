import express from "express";
import mongoose from "mongoose";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import Customer from "../models/Customer.js";
import { auth, requireRole } from "../middleware/auth.js";
import jwt from "jsonwebtoken";

const router = express.Router();

const withDerived = (p) => {
  const obj = p.toObject ? p.toObject() : { ...p };
  if (obj.mrp != null && obj.price != null && obj.mrp > obj.price) {
    obj.discountPercent = Math.round(((Number(obj.mrp) - Number(obj.price)) / Number(obj.mrp)) * 100);
  }
  return obj;
};

const sanitizeForViewer = (p, canViewPrice) => {
  let obj = withDerived(p);
  if (canViewPrice) return obj;
  delete obj.price;
  delete obj.gst;
  delete obj.mrp;
  delete obj.discountPercent;
  delete obj.bulkDiscountQuantity;
  delete obj.bulkDiscountPriceReduction;
  return obj;
};

const isViewerAuthorized = (req) => {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");
    if (type === "Bearer" && token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      return !!payload;
    }
  } catch {}
  return false;
};
// Reorder suggestions for logged-in customer
router.get("/reorder", auth, requireRole("customer"), async (req, res) => {
  const cust = await Customer.findById(req.user.id).select("phone");
  if (!cust) return res.status(404).json({ error: "not_found" });
  const orders = await Order.find({ "customer.phone": cust.phone }).select({ items: 1 }).limit(100).sort({ createdAt: -1 });
  const counts = new Map();
  for (const o of orders) {
    for (const it of o.items || []) {
      const id = it.product?.toString?.() || String(it.product);
      counts.set(id, (counts.get(id) || 0) + (Number(it.quantity) || 1));
    }
  }
  const sortedIds = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 12);
  const docs = await Product.find({ _id: { $in: sortedIds }, isActive: true });
  const docMap = new Map(docs.map(d => [d._id.toString(), d]));
  const ordered = sortedIds.map(id => docMap.get(id)).filter(Boolean);
  res.json(ordered.map(d => sanitizeForViewer(d, true)));
});

// Trending products for Home Page
router.get("/trending", async (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
  // Criteria: high rating, bestseller, or recently added with stock
  const items = await Product.find({ isActive: true, stock: { $gt: 0 } })
    .sort({ ratingCount: -1, createdAt: -1 })
    .limit(limit);
  const canView = isViewerAuthorized(req);
  res.json(items.map(d => sanitizeForViewer(d, canView)));
});

// Similar products by category & brand
router.get("/similar/:productId", async (req, res) => {
  const pid = req.params.productId;
  if (!mongoose.isValidObjectId(pid)) return res.status(400).json({ error: "invalid_id" });
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 8));
  
  const base = await Product.findById(pid).select("category brand price");
  if (!base) return res.status(404).json({ error: "not_found" });

  const priceRange = {
    $gte: Math.max(0, Number(base.price || 0) * 0.7),
    $lte: Number(base.price || 0) * 1.3
  };

  const items = await Product.find({
    isActive: true,
    _id: { $ne: base._id },
    $or: [
      { category: base.category },
      { brand: base.brand }
    ],
    ...(base.price != null ? { price: priceRange } : {})
  })
  .sort({ ratingCount: -1, stock: -1 })
  .limit(limit);

  const canView = isViewerAuthorized(req);
  res.json(items.map(d => sanitizeForViewer(d, canView)));
});

// Frequently bought together based on co-occurrence in Orders with category fallback
router.get("/frequently-bought/:productId", async (req, res) => {
  const pid = req.params.productId;
  if (!mongoose.isValidObjectId(pid)) return res.status(400).json({ error: "invalid_id" });
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 8));
  
  // 1. Get co-occurring products from orders
  const agg = await Order.aggregate([
    { $match: { "items.product": new mongoose.Types.ObjectId(pid) } },
    { $project: { items: 1 } },
    { $unwind: "$items" },
    { $match: { "items.product": { $ne: new mongoose.Types.ObjectId(pid) } } },
    { $group: { _id: "$items.product", count: { $sum: "$items.quantity" } } },
    { $sort: { count: -1 } },
    { $limit: limit }
  ]);
  
  let ids = agg.map(a => a._id);
  
  // 2. Fallback: if not enough co-occurring products, add products from same category
  const excludeIds = [...ids, new mongoose.Types.ObjectId(pid)];
  if (ids.length < 4) {
    const base = await Product.findById(pid).select("category");
    if (base && base.category) {
      const more = await Product.find({ 
        category: base.category, 
        _id: { $nin: excludeIds },
        isActive: true 
      })
      .select("_id")
      .limit(limit - ids.length);
      ids = [...ids, ...more.map(m => m._id)];
    }
  }

  // Final check to ensure current product is NEVER in the list
  const finalExclude = new Set(excludeIds.map(id => id.toString()));
  const docs = await Product.find({ 
    _id: { $in: ids, $ne: new mongoose.Types.ObjectId(pid) }, 
    isActive: true 
  });
  const canView = isViewerAuthorized(req);
  res.json(docs.filter(d => !finalExclude.has(d._id.toString())).map(d => sanitizeForViewer(d, canView)));
});

export default router;
