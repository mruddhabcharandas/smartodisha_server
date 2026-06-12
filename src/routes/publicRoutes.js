import express from "express";
import jwt from "jsonwebtoken";
import Category from "../models/Category.js";
import Store from "../models/Store.js";
import Coupon from "../models/Coupon.js";
import Bill from "../models/Bill.js";
import PartnerPayout from "../models/PartnerPayout.js";
import Partner from "../models/Partner.js";
import { sendOTP } from "../lib/mailer.js";
import { getOrSetCache, getCacheVersion } from "../lib/redis.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();

const toUpper = (s) => (s || "").toString().trim().toUpperCase();

const validateEmailFormat = (email) => {
  return String(email)
    .toLowerCase()
    .match(
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    );
};

async function computeSummaryForPartner(partner) {
  // Find all coupons linked by partner's email OR name
  const coupons = await Coupon.find({ 
    $or: [
      { partnerEmail: partner.email },
      { partner: partner._id },
      { partnerName: partner.name }
    ],
    isActive: true 
  });
  const allCodes = coupons.map(c => c.code);
  
  const bills = await Bill.find({ couponCode: { $in: allCodes } }).sort({ createdAt: -1 });
  
  const totalSales = bills.reduce((sum, b) => sum + (b.payable || 0), 0);
  
  // Safe bills list for partner (only masked phone and amount)
  const safeBills = bills.map(b => ({
    createdAt: b.createdAt,
    customerPhone: b.customerPhone ? b.customerPhone.slice(0, 2) + "****" + b.customerPhone.slice(-4) : "****",
    payable: b.payable,
    couponCode: b.couponCode
  }));

  const payouts = await PartnerPayout.find({ couponCode: { $in: allCodes } }).sort({ createdAt: -1 });
  const totalPaid = payouts.reduce((sum, p) => sum + (p.amount || 0), 0);

  // Aggregated commission calculation
  let totalCommission = 0;
  for (const c of coupons) {
    const couponSales = bills.filter(b => b.couponCode === c.code).reduce((sum, b) => sum + (b.payable || 0), 0);
    totalCommission += (couponSales * (Number(c.partnerCommissionPercent) || 0)) / 100;
  }

  const balance = totalCommission - totalPaid;

  const couponStats = coupons.map(c => {
    const couponBills = bills.filter(b => b.couponCode === c.code);
    const sales = couponBills.reduce((sum, b) => sum + (b.payable || 0), 0);
    const commission = (sales * (Number(c.partnerCommissionPercent) || 0)) / 100;
    return {
      code: c.code,
      sales,
      commission,
      commissionPercent: c.partnerCommissionPercent
    };
  });

  return {
    partnerName: partner.name,
    partnerEmail: partner.email,
    partnerPhone: partner.phone,
    totalSales,
    totalCommission,
    totalPaid,
    balance,
    coupons: couponStats,
    payouts,
    bills: safeBills
  };
}

router.get("/categories", async (req, res) => {
  const items = await getOrSetCache("categories:all", async () => {
    return await Category.find({ isActive: true }).sort({ name: 1 }).select({ name: 1, description: 1 });
  }, 86400); // 24 hours
  res.json(items);
});

router.get("/stores", async (req, res) => {
  const version = await getCacheVersion("stores");
  const items = await getOrSetCache(`stores:all:${version}`, async () => {
    return await Store.find({ isActive: true, isPopular: true }).sort({ name: 1 });
  }, 86400); // 24 hours
  res.json(items);
});

// Send OTP for Partner Login (via Email)
router.post("/partner/send-otp", rateLimit("partner-send-otp", 3, 600), async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  if (!email || !validateEmailFormat(email)) return res.status(400).json({ error: "invalid_email_format" });

  const partner = await Partner.findOne({ email, isActive: true });
  if (!partner) return res.status(404).json({ error: "partner_not_found" });

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  partner.otp = otp;
  partner.otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 mins
  await partner.save();

  try {
    await sendOTP(partner.email, otp, "PARTNER_LOGIN");
    res.json({ sent: true, email: partner.email });
  } catch (err) {
    console.error("Failed to send partner OTP:", err);
    res.status(500).json({ error: "failed_to_send_otp" });
  }
});

// Partner Login (via Email + Password/OTP)
router.post("/partner/login", rateLimit("partner-login", 10, 600), async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const { password, otp } = req.body || {};
  
  if (!email) return res.status(400).json({ error: "missing_email" });
  if (!password && !otp) return res.status(400).json({ error: "missing_credentials" });

  const partner = await Partner.findOne({ email, isActive: true });
  if (!partner) return res.status(404).json({ error: "not_found" });
  
  if (password) {
    if (!partner.password || partner.password !== password) {
      return res.status(401).json({ error: "invalid_password" });
    }
  } else if (otp) {
    if (!partner.otp || partner.otp !== otp || new Date() > partner.otpExpiry) {
      return res.status(401).json({ error: "invalid_otp" });
    }
    // Clear OTP after use
    partner.otp = undefined;
    partner.otpExpiry = undefined;
    await partner.save();
  }
  
  const token = jwt.sign(
    { id: partner._id.toString(), role: "partner", email: partner.email },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
  
  const summary = await computeSummaryForPartner(partner);
  const safePayouts = summary.payouts.map((p) => ({
    createdAt: p.createdAt,
    amount: p.amount,
    method: p.method,
    utr: p.utr,
    cashfreePaymentId: p.cashfreePaymentId,
    notes: p.notes,
    couponCode: p.couponCode
  }));
  
  res.json({
    token,
    partnerName: summary.partnerName,
    partnerEmail: summary.partnerEmail,
    partnerPhone: summary.partnerPhone,
    totalSales: summary.totalSales,
    totalCommission: summary.totalCommission,
    totalPaid: summary.totalPaid,
    balance: summary.balance,
    coupons: summary.coupons,
    payouts: safePayouts,
    bills: summary.bills
  });
});

router.get("/partner/me", (await import("../middleware/auth.js")).auth, async (req, res) => {
  if (req.user.role !== 'partner') return res.status(403).json({ error: 'forbidden' });
  const partner = await Partner.findById(req.user.id);
  if (!partner || !partner.isActive) return res.status(404).json({ error: "not_found" });
  
  const summary = await getOrSetCache(`partner:summary:${partner._id}`, async () => {
    return await computeSummaryForPartner(partner);
  }, 900); // 15 minutes
  
  res.json(summary);
});

export default router;
