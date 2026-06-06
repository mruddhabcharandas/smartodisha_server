import express from "express";
import mongoose from "mongoose";
import Product from "../models/Product.js";
import Store from "../models/Store.js";
import AuditLog from "../models/AuditLog.js";
import Category from "../models/Category.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import StockTxn from "../models/StockTxn.js";
import Bill from "../models/Bill.js";
import Order from "../models/Order.js";
import Customer from "../models/Customer.js";
import Review from "../models/Review.js";
import jwt from "jsonwebtoken";
import { getOrSetCache, delCache, getCacheVersion, bumpCacheVersion } from "../lib/redis.js";

const router = express.Router();

// 30s in-memory cache for recommend endpoint
const _recCache = new Map(); // key -> { expire:number, data:any }
const _now = () => Date.now();
const _mkKey = (id, cart) => `${id}|${(cart||[]).join(",")}`;

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

const withDerived = (p) => {
  const obj = p.toObject ? p.toObject() : { ...p };
  if (obj.mrp != null && obj.price != null && obj.mrp > obj.price) {
    obj.discountPercent = Math.round(((Number(obj.mrp) - Number(obj.price)) / Number(obj.mrp)) * 100);
  }
  if (obj.packSize == null || obj.packSize === undefined) {
    obj.packSize = 1;
  }
  return obj;
};

const sanitizeProduct = (p, canViewPrice) => {
  let obj = withDerived(p);
  return obj;
};

router.get("/grouped", async (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  if (!connected) return res.status(503).json({ error: "database_unavailable", items: [] });

  const { brand, category } = req.query;
  const canViewPrice = isViewerAuthorized(req);
  
  // Get current version for grouped products to avoid slow pattern deletes
  const version = await getCacheVersion("products:grouped");
  
  // Create a unique key for the cache with versioning
  const cacheKey = `products:grouped:v${version}:${brand || "all"}:${category || "all"}:${canViewPrice}`;

  const formatted = await getOrSetCache(cacheKey, async () => {
    const query = { isActive: true };
    if (brand && mongoose.isValidObjectId(brand)) {
      query.brand = new mongoose.Types.ObjectId(brand);
    }
    if (category && mongoose.isValidObjectId(category)) {
      query.category = new mongoose.Types.ObjectId(category);
    }

    const pipeline = [
      { $match: query },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$category",
          products: { $push: "$$ROOT" }
        }
      },
      {
        $lookup: {
          from: "categories",
          localField: "_id",
          foreignField: "_id",
          as: "categoryInfo"
        }
      },
      { $unwind: "$categoryInfo" },
      { $sort: { "categoryInfo.name": 1 } }
    ];

    const groupedResults = await Product.aggregate(pipeline);
    
    return groupedResults.map(group => ({
      category: group.categoryInfo,
      items: group.products.map(p => sanitizeProduct(p, canViewPrice))
    }));
  }, 3600); // 1 hour

  res.json(formatted);
});

router.get("/", async (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  if (!connected) return res.status(503).json({ error: "database_unavailable", items: [] });
  
  try {
    const updateResult = await Product.updateMany({ packSize: { $exists: false } }, { $set: { packSize: 1 } });
    if (updateResult.modifiedCount > 0) {
      await bumpCacheVersion("products:grouped");
      await bumpCacheVersion("products:list");
    }
  } catch(e) {
    console.error("Failed to update packSize for existing products:", e);
  }
  
  const { brand, category, subCategory, store, section, q, page: _page, limit: _limit } = req.query;
  const page = Math.max(1, parseInt(_page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(_limit) || 20));
  const canViewPrice = isViewerAuthorized(req);
  
  // Get current version for products to avoid slow pattern deletes
  const version = await getCacheVersion("products:list");
  
  // Dynamic key based on query params
  const cacheKey = `products:list:v${version}:q=${q || ""}:p=${page}:l=${limit}:b=${brand || ""}:c=${category || ""}:sc=${subCategory || ""}:st=${store || ""}:sec=${section || ""}:vp=${canViewPrice}`;

  const result = await getOrSetCache(cacheKey, async () => {
    const query = { isActive: true };
    if (brand && mongoose.isValidObjectId(brand)) query.brand = brand;
    if (category && mongoose.isValidObjectId(category)) query.category = category;
    if (subCategory && mongoose.isValidObjectId(subCategory)) query.subCategory = subCategory;
    
    // Handle store query parameter: if it's a valid ObjectId, use it directly; otherwise, try to find store by name
    if (store) {
      if (mongoose.isValidObjectId(store)) {
        query.store = store;
      } else {
        // Try to find store by name
        const foundStore = await Store.findOne({ name: { $regex: new RegExp(`^${store}$`, 'i') } });
        if (foundStore) {
          query.store = foundStore._id;
        } else {
          // If no store found, use the string as is (in case store field is stored as string)
          // Or set to null to avoid error
          query.store = null;
        }
      }
    }
    
    if (section) query.section = section.toString().trim();
    
    const searchStr = q ? String(q).trim() : "";
    const words = searchStr.split(/\s+/).filter(Boolean);
    // Single "token" queries (SKU-ish or one word): match name OR product sku OR variant sku — easier stock-in search.
    const singleTokenSkuLike =
      words.length === 1 && /^[A-Za-z0-9._\-#\/]+$/.test(words[0]);
    const useRegexWide =
      !!searchStr &&
      (searchStr.length < 2 || singleTokenSkuLike);
    const useText = !!searchStr && searchStr.length >= 2 && !singleTokenSkuLike;

    if (useRegexWide) {
      const esc = searchStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { name: { $regex: esc, $options: "i" } },
        { sku: { $regex: esc, $options: "i" } },
        { "variants.sku": { $regex: esc, $options: "i" } },
      ];
    } else if (useText) {
      query.$text = { $search: searchStr };
    }

    const total = await Product.countDocuments(query);
    let cursor = Product.find(query)
      .populate("brand", "name")
      .populate("category", "name")
      .populate("subCategory", "name")
      .populate("store", "name address phone pincode city storePercentage adminCutPercentage");
    
    if (useText) {
      cursor = cursor.select({ score: { $meta: "textScore" } }).sort({ score: { $meta: "textScore" }, createdAt: -1 });
    } else {
      cursor = cursor.sort({ createdAt: -1 });
    }
    
    const items = await cursor.skip((page - 1) * limit).limit(limit);
    const safeItems = items.map((it) => sanitizeProduct(it, canViewPrice));
    
    return { page, limit, total, items: safeItems };
  }, 3600); // 1 hour

  res.json(result);
});

router.get("/low-stock", auth, requirePermission("inventory"), async (req, res) => {
  const threshold = Number(req.query.threshold ?? 5);
  const t = Number.isFinite(threshold) && threshold >= 0 ? threshold : 5;
  const items = await Product.find({ 
    isActive: true, 
    $or: [
      { variants: { $exists: true, $not: { $size: 0 } }, "variants.stock": { $lte: t } },
      { variants: { $exists: false }, stock: { $lte: t } },
      { variants: { $size: 0 }, stock: { $lte: t } }
    ]
  }).sort({ stock: 1, updatedAt: -1 });

  // Flatten to SKU level
  const flattened = [];
  items.forEach(p => {
    if (p.variants && p.variants.length > 0) {
      p.variants.forEach(v => {
        if (v.isActive !== false && v.stock <= t) {
          flattened.push({
            _id: p._id,
            name: p.name,
            sku: v.sku,
            stock: v.stock,
            isVariant: true,
            attributes: v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes
          });
        }
      });
    } else if (p.stock <= t) {
      flattened.push({
        _id: p._id,
        name: p.name,
        stock: p.stock,
        isVariant: false
      });
    }
  });

  res.json({ threshold: t, items: flattened.sort((a, b) => a.stock - b.stock) });
});

router.get("/:idOrSlug", async (req, res) => {
  const { idOrSlug } = req.params;
  let item;
  
  if (mongoose.isValidObjectId(idOrSlug)) {
    item = await Product.findById(idOrSlug);
  }
  
  if (!item) {
    item = await Product.findOne({ slug: idOrSlug });
  }
  
  if (!item) {
    return res.status(404).json({ error: "not_found" });
  }
  
  await item.populate("brand", "name");
  await item.populate("category", "name");
  await item.populate("subCategory", "name");
  await item.populate("store", "name address phone pincode city pickupAddress pickupName pickupPhone storePercentage adminCutPercentage");
  
  if (!item.isActive) return res.status(404).json({ error: "not_found" });
  const canViewPrice = isViewerAuthorized(req);
  res.json(sanitizeProduct(item, canViewPrice));
});

// Similar products by category
router.get("/:idOrSlug/recommendations", async (req, res) => {
  const { idOrSlug } = req.params;
  let base;
  
  if (mongoose.isValidObjectId(idOrSlug)) {
    base = await Product.findById(idOrSlug).select({ category: 1, brand: 1, price: 1, _id: 1, isActive: 1 });
  }
  
  if (!base) {
    base = await Product.findOne({ slug: idOrSlug }).select({ category: 1, brand: 1, price: 1, _id: 1, isActive: 1 });
  }
  
  if (!base || !base.isActive) return res.status(404).json({ error: "not_found" });
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 6));
  const priceRange = {
    $gte: Math.max(0, Number(base.price || 0) * 0.8),
    $lte: Number(base.price || 0) * 1.2
  };
  const items = await Product.find({
      isActive: true,
      category: base.category,
      ...(base.brand ? { brand: base.brand } : {}),
      ...(base.price != null ? { price: priceRange } : {}),
      _id: { $ne: base._id }
    })
    .sort({ stock: -1, createdAt: -1 })
    .limit(limit);
  const canViewPrice = isViewerAuthorized(req);
  res.json(items.map((it) => sanitizeProduct(it, canViewPrice)));
});

  // Single recommendation for add-to-cart modal
router.get("/recommend", async (req, res) => {
  const id = String(req.query.productId || "").trim();
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "invalid_id" });
  const base = await Product.findById(id).select({ category: 1, brand: 1, price: 1, isActive: 1 });
  if (!base || !base.isActive) return res.status(404).json({ error: "not_found" });
  const priceRange = {
    $gte: Math.max(0, Number(base.price || 0) * 0.8),
    $lte: Number(base.price || 0) * 1.2
  };
  const excludeIds = String(req.query.cart || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(x => mongoose.isValidObjectId(x));
  const key = _mkKey(id, excludeIds);
  const cached = _recCache.get(key);
  if (cached && cached.expire > _now()) {
    const canViewPrice = isViewerAuthorized(req);
    return res.json({ items: (cached.data || []).map((it) => sanitizeProduct(it, canViewPrice)) });
  }
  const filter = {
    isActive: true,
    category: base.category,
    ...(base.brand ? { brand: base.brand } : {}),
    ...(base.price != null ? { price: priceRange } : {}),
    _id: excludeIds.length ? { $ne: base._id, $nin: excludeIds } : { $ne: base._id }
  };
  const candidates = await Product.find(filter).sort({ stock: -1, createdAt: -1 }).limit(20).lean();
  const withMargin = candidates.map(c => {
    const margin = (c.margin != null) ? Number(c.margin) : ((c.mrp && c.mrp > c.price) ? (c.mrp - c.price) : 0);
    return { doc: c, margin };
  }).sort((a, b) => (b.margin - a.margin));
  const pick = withMargin.length ? [withMargin[0].doc] : [];
  _recCache.set(key, { expire: _now() + 30_000, data: pick });
  const canViewPrice = isViewerAuthorized(req);
  res.json({ items: pick.map((it) => sanitizeProduct(it, canViewPrice)) });
});

router.post("/", auth, requirePermission("products"), async (req, res) => {
  const { name, price, categoryId, subCategoryId, images, stock, weight, gst, description, highlights, specifications, bulkDiscountQuantity, bulkDiscountPriceReduction, mrp, bulkTiers, variants, brandId, minOrderQty, store, section, hsnCode, sku, packSize } = req.body || {};
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
    store: store ? String(store).trim() : "",
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
});

router.put("/:id", auth, requirePermission("products"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const allowed = ["name", "description", "highlights", "specifications", "price", "categoryId", "subCategoryId", "images", "stock", "weight", "gst", "mrp", "isActive", "bulkDiscountQuantity", "bulkDiscountPriceReduction", "bulkTiers", "variants", "brandId", "minOrderQty", "store", "section", "hsnCode", "sku", "packSize"];
  const payload = {};
  for (const k of allowed) if (k in req.body) payload[k] = req.body[k];
  if (payload.packSize !== undefined) payload.packSize = Number(payload.packSize || 1);
  
  const beforeDoc = await Product.findById(req.params.id).select({ price: 1, bulkTiers: 1, gst: 1, minOrderQty: 1, variants: 1, stock: 1 });
  if (!beforeDoc) return res.status(404).json({ error: "not_found" });

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
  if (Array.isArray(payload.variants) && payload.variants.length > 0) {
    payload.variants = payload.variants.map(v => {
      const variantAttrs = {};
      if (v.attributes && typeof v.attributes === 'object') {
        Object.entries(v.attributes).forEach(([key, val]) => {
          variantAttrs[key.toLowerCase()] = String(val || '').trim();
        });
      }
      // If variant exists, keep its stock unless explicitly provided
      let existingStock = 0;
      if (v._id && beforeDoc && beforeDoc.variants) {
        const existing = beforeDoc.variants.find(ex => ex._id.toString() === v._id.toString());
        if (existing) existingStock = existing.stock || 0;
      }
      return {
        _id: v._id || new mongoose.Types.ObjectId(),
        attributes: variantAttrs,
        price: Number(v?.price ?? 0),
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
    // If variants array is explicitly empty, don't overwrite stock from it.
    // This allows simple products to maintain their manually entered stock.
    delete payload.variants;
  } else {
    // If variants is not provided at all, preserve existing stock if not in payload
    if (!("stock" in req.body) && beforeDoc) {
      payload.stock = beforeDoc.stock;
    }
  }

  // Automatic Price Trend calculation
  if (payload.price != null && beforeDoc) {
    const newPrice = Number(payload.price);
    const oldPrice = Number(beforeDoc.price);
    const mrp = payload.mrp != null ? Number(payload.mrp) : (beforeDoc.mrp ? Number(beforeDoc.mrp) : newPrice);
    
    // Safety check: Price should not exceed MRP
    if (newPrice > mrp) {
      return res.status(400).json({ error: "price_cannot_exceed_mrp" });
    }

    if (newPrice > oldPrice) {
      payload.priceTrend = 1; // UP
    } else {
      payload.priceTrend = 0; // DOWN (default/stable)
    }
  }

  const updated = await Product.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
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
        actorId: req.user?.id || "",
        actorRole: req.user?.role || "",
        type: "PRODUCT_UPDATE",
        entityType: "PRODUCT",
        entityId: updated._id.toString(),
        before: changes,
        after: null,
        note: "Product updated"
      });
    }
  } catch {}
  await bumpCacheVersion("products:grouped");
  await bumpCacheVersion("products:list");
  res.json(updated);
});

// Variant operations
router.post("/:id/variants", auth, requirePermission("products"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const p = await Product.findById(req.params.id);
  if (!p || !p.isActive) return res.status(404).json({ error: "not_found" });
  const v = req.body || {};
  const sku = v?.sku ? String(v.sku).trim() : undefined;
  if (sku) {
    const conflict = await Product.findOne({ "variants.sku": sku });
    if (conflict) return res.status(400).json({ error: "sku_exists" });
  }
  const attrs = new Map();
  if (v?.attributes && typeof v.attributes === 'object') {
    Object.entries(v.attributes).forEach(([key, val]) => {
      if (key && val) {
        attrs.set(key.toLowerCase().trim(), String(val).trim());
      }
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
});

router.put("/:id/variants/:vid", auth, requirePermission("products"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const p = await Product.findById(req.params.id);
  if (!p || !p.isActive) return res.status(404).json({ error: "not_found" });
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
        if (key && val) {
          attrs.set(key.toLowerCase().trim(), String(val).trim());
        }
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
  if (payload.price != null) v.price = Number(payload.price);
  if (payload.mrp != null) v.mrp = Number(payload.mrp);
  if (payload.stock != null) {
    const qty = Number(payload.stock);
    const before = v.stock;
    v.stock = qty;
    // Recalculate total product stock
    p.stock = (p.variants || []).filter(vx => vx.isActive !== false).reduce((s, vx) => s + (vx.stock || 0), 0);
    await p.save();
    await StockTxn.create({ product: p._id, type: "ADJUST", quantity: qty, before, after: qty, variantSku: v.sku });
  }
  if (payload.isActive != null) {
    v.isActive = !!payload.isActive;
    // Recalculate total product stock as active status changed
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
});

router.delete("/:id/variants/:vid", auth, requirePermission("products"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const p = await Product.findById(req.params.id);
  if (!p || !p.isActive) return res.status(404).json({ error: "not_found" });
  
  const initialCount = p.variants?.length || 0;
  p.variants = (p.variants || []).filter(v => v._id.toString() !== req.params.vid);
  
  if (p.variants.length === initialCount) return res.status(404).json({ error: "variant_not_found" });
  
  p.markModified("variants");
  await p.save();
  
  // Recalculate total product stock
  try {
    const sum = (p.variants || []).filter(x => x.isActive !== false).reduce((s, x) => s + Number(x.stock || 0), 0);
    p.stock = Number.isFinite(sum) ? sum : 0;
    await p.save();
  } catch {}
  
  await bumpCacheVersion("products:grouped");
  await bumpCacheVersion("products:list");
  
  res.json({ success: true });
});

router.patch("/:id/variants/:vid/stock", auth, requirePermission("inventory"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const qty = Number(req.body?.quantity);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: "invalid_quantity" });
  const p = await Product.findById(req.params.id);
  if (!p || !p.isActive) return res.status(404).json({ error: "not_found" });
  const idx = (p.variants || []).findIndex(v => v._id.toString() === req.params.vid);
  if (idx === -1) return res.status(404).json({ error: "variant_not_found" });
  const v = p.variants[idx];
  if ((v.stock || 0) - qty < 0) return res.status(400).json({ error: "insufficient_stock" });
  const before = v.stock || 0;
  v.stock = before - qty;
  p.markModified("variants");
  await p.save();
  try {
    const sum = (p.variants || []).filter(x => x.isActive !== false).reduce((s, x) => s + Number(x.stock || 0), 0);
    p.stock = Number.isFinite(sum) ? sum : 0;
    await p.save();
  } catch {}
  await StockTxn.create({ product: p._id, type: req.body?.reason === "ADJUST" ? "ADJUST" : "SOLD", quantity: qty, before, after: v.stock, refType: "MANUAL", note: req.body?.note || "", variantSku: v.sku });
  res.json({ id: v._id.toString(), stock: v.stock });
});

router.delete("/:id", auth, requirePermission("products"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const updated = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ success: true });
});

router.patch("/:id/stock", auth, requirePermission("inventory"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const qty = Number(req.body?.quantity);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: "invalid_quantity" });
  const doc = await Product.findById(req.params.id);
  if (!doc || !doc.isActive) return res.status(404).json({ error: "not_found" });
  if (doc.stock - qty < 0) return res.status(400).json({ error: "insufficient_stock" });
  const before = doc.stock;
  doc.stock -= qty;
  await doc.save();
  await StockTxn.create({ product: doc._id, type: req.body?.reason === "ADJUST" ? "ADJUST" : "SOLD", quantity: qty, before, after: doc.stock, refType: "MANUAL", note: req.body?.note || "" });
  res.json({ id: doc._id.toString(), stock: doc.stock });
});

router.get("/:id/stock-history", auth, requirePermission("inventory"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const items = await StockTxn.find({ product: req.params.id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
  res.json({ page, limit, count: items.length, items });
});

router.get("/suggest", async (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  if (!connected) return res.json([]);
  const q = req.query.q ? String(req.query.q).trim() : "";
  if (!q) return res.json([]);
  const base = { isActive: true };
  let items = [];
  if (q.length >= 2) {
    items = await Product.find({ ...base, $text: { $search: q } })
      .select({ name: 1, category: 1, images: 1, score: { $meta: "textScore" } })
      .sort({ score: { $meta: "textScore" } })
      .limit(8);
  } else {
    items = await Product.find({ ...base, name: { $regex: q, $options: "i" } })
      .select({ name: 1, category: 1, images: 1 })
      .sort({ createdAt: -1 })
      .limit(8);
  }
  const out = items.map((d) => ({
    id: d._id.toString(),
    name: d.name,
    category: d.category,
    image: d.images?.[0]?.url || ""
  }));
  res.json(out);
});
router.post("/:id/reviews", auth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { rating, comment } = req.body || {};
  const r = Number(rating);
  if (!Number.isFinite(r) || r < 1 || r > 5) return res.status(400).json({ error: "invalid_rating" });
  const product = await Product.findById(req.params.id);
  if (!product || !product.isActive) return res.status(404).json({ error: "not_found" });
  const billEligible = await Bill.exists({ customer: req.user?.id, "items.product": product._id });
  let orderEligible = false;
  if (!billEligible && req.user?.id) {
    const cust = await Customer.findById(req.user.id).select("phone").lean();
    const phone = cust?.phone ? String(cust.phone).replace(/\D/g, "").slice(-10) : "";
    if (phone.length === 10) {
      const recent = await Order.find({
        "items.product": product._id,
        status: { $in: ["DELIVERED", "FULFILLED", "SHIPPED", "CONFIRMED"] }
      })
        .select("customer.phone")
        .sort({ createdAt: -1 })
        .limit(80)
        .lean();
      orderEligible = recent.some(
        (o) => String(o.customer?.phone || "").replace(/\D/g, "").slice(-10) === phone
      );
    }
  }
  if (!billEligible && !orderEligible) return res.status(403).json({ error: "not_eligible" });
  await Review.findOneAndUpdate(
    { product: product._id, customer: req.user.id },
    { rating: r, comment: comment || "" },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const agg = await Review.aggregate([
    { $match: { product: product._id } },
    { $group: { _id: "$product", count: { $sum: 1 }, avg: { $avg: "$rating" } } }
  ]);
  const summary = agg[0] || { count: 0, avg: 0 };
  await Product.updateOne({ _id: product._id }, { ratingAvg: Number(summary.avg || 0).toFixed ? Number(summary.avg.toFixed(2)) : Number(summary.avg || 0), ratingCount: summary.count || 0 });
  const updated = await Product.findById(product._id).select({ ratingAvg: 1, ratingCount: 1 });
  res.status(201).json({ ratingAvg: updated.ratingAvg || 0, ratingCount: updated.ratingCount || 0 });
});

export default router;
