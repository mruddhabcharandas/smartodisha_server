import express from "express";
import mongoose from "mongoose";
import Coupon from "../models/Coupon.js";
import { auth, requireRole } from "../middleware/auth.js";

const router = express.Router();

const toUpper = (s) => (s || "").toString().trim().toUpperCase();

router.post("/", auth, requireRole("admin"), async (req, res) => {
  const code = toUpper(req.body?.code);
  const { type, value, minAmount, minOrderValue, maxDiscount, expiryDate, usageLimit, partnerId, partnerName, partnerEmail, partnerPhone, partnerCommissionPercent, maxTotalSales, isActive, password } = req.body || {};
  if (!code || !type || value == null || !expiryDate) return res.status(400).json({ error: "missing_fields" });
  const exists = await Coupon.findOne({ code });
  if (exists) return res.status(409).json({ error: "duplicate_code" });
  let partnerRef = undefined;
  let pName = partnerName || "";
  let pEmail = partnerEmail || "";
  let pPhone = partnerPhone || "";
  if (partnerId) {
    if (!mongoose.isValidObjectId(partnerId)) return res.status(400).json({ error: "invalid_partner" });
    const partner = await (await import("../models/Partner.js")).default.findById(partnerId);
    if (!partner) return res.status(404).json({ error: "partner_not_found" });
    partnerRef = partner._id;
    if (!pName) pName = partner.name || "";
    if (!pEmail) pEmail = partner.email || "";
    if (!pPhone) pPhone = partner.phone || "";
  }
  const doc = await Coupon.create({
    code,
    type,
    value: Number(value),
    minAmount: Number(minAmount || minOrderValue || 0),
    minOrderValue: Number(minOrderValue || minAmount || 0),
    maxDiscount: Number(maxDiscount || 0),
    expiryDate: new Date(expiryDate),
    usageLimit: Number(usageLimit || 0),
    partner: partnerRef,
    partnerName: pName,
    partnerEmail: pEmail,
    partnerPhone: pPhone,
    partnerCommissionPercent: Number(partnerCommissionPercent || 0),
    maxTotalSales: Number(maxTotalSales || 0),
    password: password ? String(password).trim() : undefined,
    isActive: isActive === false ? false : true
  });
  res.status(201).json(doc);
});

router.get("/", auth, requireRole("admin"), async (req, res) => {
  const items = await Coupon.find({}).sort({ createdAt: -1 });
  res.json(items);
});

router.put("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const payload = {};
  if (req.body?.code) payload.code = toUpper(req.body.code);
  if (req.body?.type) payload.type = req.body.type;
  if (req.body?.value != null) payload.value = Number(req.body.value);
  if (req.body?.minAmount != null) {
    payload.minAmount = Number(req.body.minAmount);
    payload.minOrderValue = Number(req.body.minAmount);
  }
  if (req.body?.minOrderValue != null) {
    payload.minOrderValue = Number(req.body.minOrderValue);
    payload.minAmount = Number(req.body.minOrderValue);
  }
  if (req.body?.maxDiscount != null) payload.maxDiscount = Number(req.body.maxDiscount);
  if (req.body?.expiryDate) payload.expiryDate = new Date(req.body.expiryDate);
  if (req.body?.usageLimit != null) payload.usageLimit = Number(req.body.usageLimit);
  if (req.body?.isActive != null) payload.isActive = !!req.body.isActive;
  if (req.body?.partnerName != null) payload.partnerName = req.body.partnerName;
  if (req.body?.partnerEmail != null) payload.partnerEmail = req.body.partnerEmail;
  if (req.body?.partnerPhone != null) payload.partnerPhone = req.body.partnerPhone;
  if (req.body?.partnerCommissionPercent != null) payload.partnerCommissionPercent = Number(req.body.partnerCommissionPercent);
  if (req.body?.maxTotalSales != null) payload.maxTotalSales = Number(req.body.maxTotalSales);
  if (req.body?.password !== undefined) payload.password = req.body.password ? String(req.body.password).trim() : undefined;
  if (req.body?.partnerId !== undefined) {
    if (req.body.partnerId === "") {
      payload.partner = null;
      payload.partnerName = "";
      payload.partnerEmail = "";
      payload.partnerPhone = "";
    } else {
      if (!mongoose.isValidObjectId(req.body.partnerId)) return res.status(400).json({ error: "invalid_partner" });
      const partner = await (await import("../models/Partner.js")).default.findById(req.body.partnerId);
      if (!partner) return res.status(404).json({ error: "partner_not_found" });
      payload.partner = partner._id;
      payload.partnerName = partner.name || "";
      payload.partnerEmail = partner.email || "";
      payload.partnerPhone = partner.phone || "";
    }
  }
  if (payload.code) {
    const dup = await Coupon.findOne({ code: payload.code, _id: { $ne: req.params.id } });
    if (dup) return res.status(409).json({ error: "duplicate_code" });
  }
  const updated = await Coupon.findByIdAndUpdate(req.params.id, payload, { new: true });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json(updated);
});

router.post("/validate", auth, async (req, res) => {
  const code = toUpper(req.body.code);
  const amount = Number(req.body.amount || 0);
  if (!code) return res.status(400).json({ error: "missing_code" });

  const coupon = await Coupon.findOne({ code, isActive: true });
  if (!coupon) return res.status(404).json({ error: "invalid_coupon" });

  if (coupon.expiryDate && new Date() > coupon.expiryDate) {
    return res.status(400).json({ error: "coupon_expired" });
  }

  const minVal = coupon.minOrderValue || coupon.minAmount || 0;
  if (amount < minVal) {
    return res.status(400).json({ error: `min_order_value_not_met:${minVal}` });
  }

  if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
    return res.status(400).json({ error: "usage_limit_reached" });
  }

  let discount = coupon.type === "PERCENT" ? (amount * coupon.value) / 100 : coupon.value;
  if (coupon.maxDiscount > 0 && discount > coupon.maxDiscount) {
    discount = coupon.maxDiscount;
  }
  if (discount > amount) discount = amount;

  res.json({
    valid: true,
    code: coupon.code,
    discount,
    payable: amount - discount,
    type: coupon.type,
    value: coupon.value
  });
});

router.delete("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) return res.status(404).json({ error: "not_found" });

  if (coupon.isActive) {
    // If active, just disable it first
    coupon.isActive = false;
    await coupon.save();
    return res.json({ success: true, message: "disabled", doc: coupon });
  } else {
    // If already inactive, delete permanently
    await Coupon.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: "deleted" });
  }
});

router.post("/validate", async (req, res) => {
  const code = toUpper(req.body?.code);
  const amount = Number(req.body?.amount);
  if (!code || !Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "invalid_input" });
  const now = new Date();
  const c = await Coupon.findOne({ code });
  if (!c || !c.isActive) return res.status(404).json({ valid: false, reason: "inactive" });
  if (c.expiryDate && c.expiryDate < now) return res.status(400).json({ valid: false, reason: "expired" });
  if (c.usageLimit > 0 && c.usedCount >= c.usageLimit) return res.status(400).json({ valid: false, reason: "limit_reached" });
  if (amount < (c.minAmount || 0)) return res.status(400).json({ valid: false, reason: "below_min_amount" });
  let discount = 0;
  if (c.type === "PERCENT") discount = (amount * c.value) / 100;
  if (c.type === "FLAT") discount = c.value;
  if (discount > amount) discount = amount;
  const payable = Number((amount - discount).toFixed(2));
  res.json({ valid: true, code, discount: Number(discount.toFixed(2)), payable });
});

export default router;

