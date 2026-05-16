import express from "express";
import mongoose from "mongoose";
import Category from "../models/Category.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import { delCache, bumpCacheVersion } from "../lib/redis.js";

const router = express.Router();

router.post("/", auth, requirePermission("products"), async (req, res) => {
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
});

router.get("/", async (req, res) => {
  const active = req.query.active;
  const brandId = req.query.brand;
  const filter = {};
  if (active === "true") filter.isActive = true;
  if (active === "false") filter.isActive = false;
  if (brandId) {
    if (!mongoose.isValidObjectId(brandId)) return res.status(400).json({ error: "invalid_brand_id" });
    filter.$or = [{ brand: brandId }, { brand: null }];
  }
  const items = await Category.find(filter).populate("brand", "name").sort({ name: 1 });
  res.json(items);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { name, slug, brandId, image, description, isActive, attributes } = req.body || {};
  const payload = {};
  if (name) payload.name = name.toLowerCase();
  if (slug) payload.slug = slug.toLowerCase();
  if (brandId !== undefined) {
    if (brandId && !mongoose.isValidObjectId(brandId)) return res.status(400).json({ error: "invalid_brand" });
    payload.brand = brandId || null;
  }
  if (image !== undefined) payload.image = image;
  if (description !== undefined) payload.description = description;
  if (isActive !== undefined) payload.isActive = isActive;
  if (attributes !== undefined) {
    payload.attributes = Array.isArray(attributes) ? attributes.map(a => a.toLowerCase().trim()) : [];
  }
  
  const updated = await Category.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  await delCache("categories:all");
  await bumpCacheVersion("products:grouped");
  await bumpCacheVersion("products:list");
  res.json(updated);
});

router.delete("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const deleted = await Category.findByIdAndDelete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "not_found" });
  await delCache("categories:all");
  await bumpCacheVersion("products:grouped");
  await bumpCacheVersion("products:list");
  res.json({ success: true });
});

export default router;
