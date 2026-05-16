import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Coupon from "../models/Coupon.js";
import Bill from "../models/Bill.js";
import PartnerPayout from "../models/PartnerPayout.js";

const router = express.Router();

const toUpper = (s) => (s || "").toString().trim().toUpperCase();

async function computeSummaryForCoupon(coupon) {
  const code = coupon.code;
  const bills = await Bill.find({ couponCode: code });
  const totalSales = bills.reduce((sum, b) => sum + (b.payable || 0), 0);
  const commissionPercent = Number(coupon.partnerCommissionPercent || 0);
  const totalCommission = (totalSales * commissionPercent) / 100;
  
  // Category breakdown
  const categoryMap = {};
  for (const b of bills) {
    const billCommission = (b.payable * commissionPercent) / 100;
    // Distribute bill commission across its items' categories proportionately
    for (const it of b.items) {
      const cat = it.category || "General";
      const itemWeight = it.lineTotal / (b.total || 1);
      const itemComm = billCommission * itemWeight;
      categoryMap[cat] = (categoryMap[cat] || 0) + itemComm;
    }
  }
  const categoryBreakdown = Object.entries(categoryMap).map(([name, value]) => ({ name, value }));

  const payouts = await PartnerPayout.find({ couponCode: code }).sort({ createdAt: -1 });
  const totalPaid = payouts.reduce((sum, p) => sum + (p.amount || 0), 0);
  const balance = totalCommission - totalPaid;
  return {
    couponId: coupon._id,
    code,
    partnerName: coupon.partnerName || "",
    partnerEmail: coupon.partnerEmail || "",
    partnerPhone: coupon.partnerPhone || "",
    commissionPercent,
    totalSales,
    totalCommission,
    totalPaid,
    balance,
    categoryBreakdown,
    payouts
  };
}

// Admin: list all partner coupons with aggregates
router.get("/", auth, requireRole("admin"), async (req, res) => {
  const coupons = await Coupon.find({
    $or: [
      { partnerName: { $ne: "" } },
      { partnerCommissionPercent: { $gt: 0 } }
    ]
  }).sort({ createdAt: -1 });
  const summaries = await Promise.all(coupons.map((c) => computeSummaryForCoupon(c)));
  res.json(summaries);
});

// Admin: record a payout against a partner's coupon
router.post("/:code/payout", auth, requireRole("admin"), async (req, res) => {
  const code = toUpper(req.params.code);
  const { amount, method, utr, razorpayPaymentId, notes } = req.body || {};
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }
  const coupon = await Coupon.findOne({ code, isActive: true });
  if (!coupon) return res.status(404).json({ error: "not_found" });
  const payout = await PartnerPayout.create({
    coupon: coupon._id,
    couponCode: coupon.code,
    amount: numericAmount,
    method: method === "RAZORPAY" ? "RAZORPAY" : "MANUAL",
    utr: utr || "",
    razorpayPaymentId: razorpayPaymentId || "",
    notes: notes || ""
  });
  const summary = await computeSummaryForCoupon(coupon);
  res.status(201).json({ payout, summary });
});

export default router;

