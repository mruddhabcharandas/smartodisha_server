import express from "express";
import mongoose from "mongoose";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import Product from "../models/Product.js";
import Order from "../models/Order.js";
import StockTxn from "../models/StockTxn.js";
import AuditLog from "../models/AuditLog.js";

const router = express.Router();

// Stock IN: increase product stock and log entry
router.post("/in", auth, requirePermission("inventory"), async (req, res) => {
  const { productId, variantSku, quantity, note } = req.body || {};
  if (!mongoose.isValidObjectId(productId)) return res.status(400).json({ error: "invalid_product" });
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: "invalid_quantity" });
  
  const doc = await Product.findById(productId);
  if (!doc || !doc.isActive) return res.status(404).json({ error: "not_found" });

  // If product has variants, variantSku MUST be provided
  if (doc.variants && doc.variants.length > 0 && !variantSku) {
    return res.status(400).json({ error: "variant_sku_required" });
  }

  let before = 0;
  let after = 0;

  if (variantSku) {
    const vIdx = (doc.variants || []).findIndex(v => v.sku === String(variantSku));
    if (vIdx === -1) return res.status(404).json({ error: "variant_not_found" });
    before = doc.variants[vIdx].stock || 0;
    doc.variants[vIdx].stock = before + qty;
    // Recalculate total product stock
    doc.stock = (doc.variants || []).filter(vx => vx.isActive !== false).reduce((s, vx) => s + (vx.stock || 0), 0);
    after = doc.variants[vIdx].stock;
  } else {
    before = doc.stock || 0;
    doc.stock = before + qty;
    after = doc.stock;
  }

  await doc.save();
  await StockTxn.create({
    product: doc._id,
    variantSku: variantSku ? String(variantSku) : doc.sku,
    type: "ADDED",
    quantity: qty,
    before,
    after,
    refType: "MANUAL",
    note: note || ""
  });

  try {
    await AuditLog.create({
      actorId: req.user?.id || "",
      actorRole: req.user?.role || "",
      type: "STOCK",
      entityType: "PRODUCT",
      entityId: doc._id.toString(),
      note: `Stock IN +${qty} ${variantSku ? '(Variant SKU: ' + variantSku + ')' : ''} ${note || ""}`,
      before: { stock: before },
      after: { stock: after }
    });
  } catch {}
  res.status(201).json({ productId: doc._id.toString(), variantSku, before, added: qty, after });
});

// Stock IN (Bulk): increase product stock for multiple variants at once
router.post("/bulk-in", auth, requirePermission("inventory"), async (req, res) => {
  const { updates, note } = req.body || {};
  if (!Array.isArray(updates) || updates.length === 0) {
     return res.status(400).json({ error: "no_updates_provided" });
  }

  const results = [];
  
  for (const item of updates) {
    const { productId, variantSku, quantity } = item;
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) continue;

    const doc = await Product.findById(productId);
    if (!doc || !doc.isActive) continue;

    if (doc.variants && doc.variants.length > 0 && !variantSku) continue;

    let before = 0;
    let after = 0;

    if (variantSku) {
      const vIdx = (doc.variants || []).findIndex(v => v.sku === String(variantSku));
      if (vIdx === -1) continue;
      before = doc.variants[vIdx].stock || 0;
      doc.variants[vIdx].stock = before + qty;
      doc.stock = (doc.variants || []).filter(vx => vx.isActive !== false).reduce((s, vx) => s + (vx.stock || 0), 0);
      after = doc.variants[vIdx].stock;
    } else {
      before = doc.stock || 0;
      doc.stock = before + qty;
      after = doc.stock;
    }

    await doc.save();
    
    await StockTxn.create({
      product: doc._id,
      variantSku: variantSku ? String(variantSku) : doc.sku,
      type: "ADDED",
      quantity: qty,
      before,
      after,
      refType: "MANUAL",
      note: note || ""
    });

    try {
      await AuditLog.create({
        actorId: req.user?.id || "",
        actorRole: req.user?.role || "",
        type: "STOCK",
        entityType: "PRODUCT",
        entityId: doc._id.toString(),
        note: `Bulk Stock IN +${qty} ${variantSku ? '(Variant SKU: ' + variantSku + ')' : ''} ${note || ""}`,
        before: { stock: before },
        after: { stock: after }
      });
    } catch {}

    results.push({ productId: doc._id.toString(), variantSku, added: qty });
  }

  res.status(200).json({ success: true, updated: results.length, results });
});

// History: list recent stock-in records
router.get("/history", auth, requirePermission("inventory"), async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const items = await StockTxn.find({ type: "ADDED" })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate("product", "name store section");
  const out = items.map((x) => ({
    id: x._id.toString(),
    productId: x.product?._id?.toString?.() || "",
    productName: x.product?.name || "",
    variantSku: x.variantSku || "",
    store: x.product?.store || "",
    section: x.product?.section || "",
    quantity: x.quantity,
    note: x.note || "",
    before: x.before,
    after: x.after,
    createdAt: x.createdAt
  }));
  res.json({ page, limit, count: out.length, items: out });
});

// Summary analytics
router.get("/summary", auth, requirePermission("inventory"), async (req, res) => {
  const days = Math.min(90, Math.max(7, parseInt(req.query.days) || 30));
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  const dailyAgg = await StockTxn.aggregate([
    { $match: { type: "ADDED", createdAt: { $gte: from } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, qty: { $sum: "$quantity" } } },
    { $sort: { _id: 1 } }
  ]);
  const byProduct = await StockTxn.aggregate([
    { $match: { type: "ADDED", createdAt: { $gte: from } } },
    { $group: { _id: "$product", qty: { $sum: "$quantity" } } },
    { $sort: { qty: -1 } },
    { $limit: 10 }
  ]);
  const ids = byProduct.map(x => x._id).filter(Boolean);
  const prodDocs = ids.length ? await Product.find({ _id: { $in: ids } }).select("name") : [];
  const nameMap = new Map(prodDocs.map(p => [p._id.toString(), p.name]));
  const topProducts = byProduct.map(x => ({ productId: x._id?.toString?.() || "", name: nameMap.get(x._id?.toString?.() || "") || "", quantity: x.qty || 0 }));
  const threshold = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);
  const lowStockProducts = await Product.find({ 
    isActive: true, 
    $or: [
      { variants: { $exists: true, $not: { $size: 0 } }, "variants.stock": { $lte: threshold } },
      { variants: { $exists: false }, stock: { $lte: threshold } },
      { variants: { $size: 0 }, stock: { $lte: threshold } }
    ]
  }).select("name stock variants").sort({ stock: 1 }).limit(20);

  const lowStockSkus = [];
  lowStockProducts.forEach(p => {
    if (p.variants && p.variants.length > 0) {
      p.variants.forEach(v => {
        if (v.isActive !== false && v.stock <= threshold) {
          lowStockSkus.push({ id: `${p._id}_${v.sku}`, name: `${p.name} (${v.sku || 'No SKU'})`, stock: v.stock });
        }
      });
    } else if (p.stock <= threshold) {
      lowStockSkus.push({ id: p._id.toString(), name: p.name, stock: p.stock });
    }
  });

  const totalProducts = await Product.countDocuments({ isActive: true });
  // Total SKUs = Products without variants + total variants of products with variants
  const productsWithVariants = await Product.find({ isActive: true, variants: { $exists: true, $not: { $size: 0 } } }).select("variants");
  const variantCount = productsWithVariants.reduce((sum, p) => sum + (p.variants?.filter(v => v.isActive !== false).length || 0), 0);
  const simpleProductCount = await Product.countDocuments({ isActive: true, $or: [{ variants: { $exists: false } }, { variants: { $size: 0 } }] });
  const totalSkusCount = simpleProductCount + variantCount;

  const inv = await Product.aggregate([{ $match: { isActive: true } }, { $group: { _id: null, units: { $sum: "$stock" } } }]);
  const totalUnits = inv[0]?.units || 0;
  const totalAdded = dailyAgg.reduce((s, d) => s + (d.qty || 0), 0);
  const daysList = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const rec = dailyAgg.find(x => x._id === key);
    daysList.push({ date: key, quantity: rec?.qty || 0 });
  }
  res.json({
    kpis: { totalSkus: totalSkusCount, totalUnits, lowStockCount: lowStockSkus.length, totalAdded30d: totalAdded },
    daily: daysList,
    topProducts,
    lowStock: lowStockSkus.sort((a, b) => a.stock - b.stock).slice(0, 10)
  });
});

export default router;

// Overview: total, reserved, available per SKU
router.get("/overview", auth, requirePermission("inventory"), async (req, res) => {
  const reservedAgg = await Order.aggregate([
    { $match: { status: { $in: ["NEW", "PENDING_CASH_APPROVAL", "CONFIRMED"] } } },
    { $unwind: "$items" },
    { $group: { _id: { productId: "$items.product", variantSku: "$items.variantSku" }, reserved: { $sum: "$items.quantity" } } }
  ]);
  
  const reservedMap = new Map();
  reservedAgg.forEach(x => {
    const key = `${x._id.productId}_${x._id.variantSku || ''}`;
    reservedMap.set(key, x.reserved || 0);
  });

  const prods = await Product.find({ isActive: true }).select("name stock variants sku");
  const items = [];
  const threshold = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);

  prods.forEach(p => {
    if (p.variants && p.variants.length > 0) {
      p.variants.forEach(v => {
        if (v.isActive !== false) {
          const key = `${p._id}_${v.sku || ''}`;
          const reserved = reservedMap.get(key) || 0;
          const available = Math.max(0, (v.stock || 0) - reserved);
          items.push({
            id: `${p._id}_${v.sku}`,
            name: p.name,
            sku: v.sku,
            total: v.stock || 0,
            reserved,
            available,
            low: available <= threshold
          });
        }
      });
    } else {
      const key = `${p._id}_`;
      const reserved = reservedMap.get(key) || 0;
      const available = Math.max(0, (p.stock || 0) - reserved);
      items.push({
        id: p._id.toString(),
        name: p.name,
        sku: p.sku || '',
        total: p.stock || 0,
        reserved,
        available,
        low: available <= threshold
      });
    }
  });

  res.json({ items: items.sort((a, b) => a.available - b.available) });
});
