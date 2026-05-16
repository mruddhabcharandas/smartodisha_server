import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Partner from "../models/Partner.js";

const router = express.Router();

router.get("/", auth, requireRole("admin"), async (req, res) => {
  const items = await Partner.find({ isActive: true }).sort({ name: 1 });
  res.json(items);
});

router.post("/", auth, requireRole("admin"), async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name) return res.status(400).json({ error: "missing_name" });
  const doc = await Partner.create({
    name: String(name).trim(),
    email: email ? String(email).trim().toLowerCase() : "",
    phone: phone ? String(phone).trim() : "",
    password: password ? String(password).trim() : undefined
  });
  res.status(201).json(doc);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const payload = {};
  if (req.body?.name != null) payload.name = String(req.body.name).trim();
  if (req.body?.email != null) payload.email = String(req.body.email).trim().toLowerCase();
  if (req.body?.phone != null) payload.phone = String(req.body.phone).trim();
  if (req.body?.password !== undefined) payload.password = req.body.password ? String(req.body.password).trim() : undefined;
  if (req.body?.isActive != null) payload.isActive = !!req.body.isActive;
  const updated = await Partner.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

export default router;

