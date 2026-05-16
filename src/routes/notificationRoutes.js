import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Product from "../models/Product.js";
import { sendLowStockEmail } from "../lib/notifications.js";

const router = express.Router();

router.post("/low-stock-email", auth, requireRole("admin"), async (req, res) => {
  const threshold = Number(req.body?.threshold ?? process.env.LOW_STOCK_THRESHOLD ?? 5);
  const t = Number.isFinite(threshold) && threshold >= 0 ? threshold : 5;
  const items = await Product.find({ isActive: true, stock: { $lte: t } }).sort({ stock: 1 });
  if (items.length === 0) return res.json({ sent: false, items: 0 });
  const result = await sendLowStockEmail(items, t);
  res.json({ ...result, items: items.length, threshold: t });
});

export default router;

