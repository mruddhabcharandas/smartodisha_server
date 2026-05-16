import express from "express";
import razorpay from "../lib/razorpay.js";
import crypto from "crypto";

const router = express.Router();

router.post("/create-order", async (req, res) => {
  const amountPaise = Number(req.body?.amountPaise || 0);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) return res.status(400).json({ error: "invalid_amount" });
  try {
    const order = await razorpay.orders.create({ amount: Math.round(amountPaise), currency: "INR", receipt: `pay_${Date.now()}` });
    res.json({ id: order.id, amount: order.amount, currency: order.currency });
  } catch (e) {
    res.status(500).json({ error: "payment_create_failed" });
  }
});

router.post("/verify", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: "invalid_payload" });
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(body.toString()).digest("hex");
  if (expectedSignature === razorpay_signature) return res.json({ success: true });
  return res.status(400).json({ error: "invalid_signature" });
});

export default router;
