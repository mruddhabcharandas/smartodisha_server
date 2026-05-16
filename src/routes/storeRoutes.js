import express from "express";
import mongoose from "mongoose";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import Store from "../models/Store.js";

const router = express.Router();

router.get("/", auth, requirePermission(["stores", "products", "inventory"]), async (req, res) => {
  const items = await Store.find({}).sort({ name: 1 });
  res.json(items);
});

router.post("/", auth, requirePermission("stores"), async (req, res) => {
  const name = (req.body?.name || "").toString().trim();
  if (!name) return res.status(400).json({ error: "missing_name" });
  const exists = await Store.findOne({ name });
  if (exists) return res.status(409).json({ error: "duplicate_name" });
  const doc = await Store.create({ name });
  res.status(201).json(doc);
});

router.put("/:id", auth, requirePermission("stores"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const payload = {};
  if (req.body?.name != null) payload.name = String(req.body.name).trim();
  if (req.body?.isActive != null) payload.isActive = !!req.body.isActive;
  const updated = await Store.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

router.post("/:id/sections", auth, requirePermission("stores"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const section = (req.body?.name || "").toString().trim();
  if (!section) return res.status(400).json({ error: "missing_section" });
  const doc = await Store.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "not_found" });
  if (!doc.sections.includes(section)) doc.sections.push(section);
  await doc.save();
  res.status(201).json(doc);
});

router.delete("/:id/sections", auth, requirePermission("stores"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const section = (req.body?.name || "").toString().trim();
  const doc = await Store.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "not_found" });
  doc.sections = doc.sections.filter(s => s !== section);
  await doc.save();
  res.json(doc);
});

export default router;
