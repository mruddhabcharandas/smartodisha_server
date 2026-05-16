import express from "express";
import Offer from "../models/Offer.js";
import { auth, requireRole } from "../middleware/auth.js";

const router = express.Router();

router.get("/", async (req, res) => {
  const query = { isActive: true };
  if (req.query.activeOnly === "true") {
    query.startDate = { $lte: new Date() };
    query.endDate = { $gte: new Date() };
  }
  const items = await Offer.find(query).populate("products", "name price images mrp").sort({ createdAt: -1 });
  res.json(items);
});

router.post("/", auth, requireRole("admin"), async (req, res) => {
  try {
    const doc = await Offer.create(req.body);
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  try {
    const doc = await Offer.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", auth, requireRole("admin"), async (req, res) => {
  await Offer.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

export default router;
