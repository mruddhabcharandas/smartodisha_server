import express from "express";
import mongoose from "mongoose";
import SubCategory from "../models/SubCategory.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";

const router = express.Router();

router.post("/", auth, requirePermission("products"), async (req, res) => {
  const { name, slug, categoryId } = req.body || {};
  if (!name || !slug || !categoryId) return res.status(400).json({ error: "missing_fields" });
  
  if (!mongoose.isValidObjectId(categoryId)) return res.status(400).json({ error: "invalid_category" });
  
  const exists = await SubCategory.findOne({ $or: [{ name }, { slug }], category: categoryId });
  if (exists) return res.status(409).json({ error: "duplicate_subcategory" });
  
  const doc = await SubCategory.create({ name, slug, category: categoryId });
  res.status(201).json(doc);
});

router.get("/", async (req, res) => {
  const filter = {};
  if (req.query.category) {
    if (!mongoose.isValidObjectId(req.query.category)) return res.status(400).json({ error: "invalid_category_id" });
    filter.category = req.query.category;
  }
  if (req.query.active === "true") filter.isActive = true;
  const items = await SubCategory.find(filter).populate("category", "name").sort({ name: 1 });
  res.json(items);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const { name, slug, categoryId, isActive } = req.body || {};
  const payload = {};
  if (name) payload.name = name;
  if (slug) payload.slug = slug;
  if (categoryId) {
    if (!mongoose.isValidObjectId(categoryId)) return res.status(400).json({ error: "invalid_category" });
    payload.category = categoryId;
  }
  if (isActive !== undefined) payload.isActive = isActive;
  
  const updated = await SubCategory.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

router.delete("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const updated = await SubCategory.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ success: true });
});

export default router;
