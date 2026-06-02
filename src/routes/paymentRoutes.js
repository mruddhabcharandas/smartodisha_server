import express from "express";
import cashfree from "../lib/cashfree.js";
import crypto from "crypto";

const router = express.Router();

router.post("/create-order", async (req, res) => {
  const amount = Number(req.body?.amount || 0);
  const orderId = `order_${Date.now()}`;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "invalid_amount" });
  try {
    const { data } = await cashfree.post("/pg/orders", {
      order_id: orderId,
      order_amount: amount,
      order_currency: "INR",
      customer_details: {
        customer_id: `customer_${Date.now()}`,
        customer_name: "Customer",
        customer_email: "customer@example.com",
        customer_phone: "9999999999"
      }
    });
    res.json({ 
      orderId: data.order_id, 
      amount: data.order_amount, 
      currency: data.order_currency,
      paymentSessionId: data.payment_session_id
    });
  } catch (e) {
    console.error("Cashfree order creation failed:", e.response?.data || e.message);
    res.status(500).json({ error: "payment_create_failed" });
  }
});

router.post("/verify", async (req, res) => {
  const { orderId, orderAmount, paymentSignature } = req.body || {};
  if (!orderId || !orderAmount || !paymentSignature) return res.status(400).json({ error: "invalid_payload" });
  
  const signatureData = `${orderId}${orderAmount}`;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.CASHFREE_SECRET_KEY)
    .update(signatureData)
    .digest("base64");
  
  if (expectedSignature === paymentSignature) {
    return res.json({ success: true });
  }
  return res.status(400).json({ error: "invalid_signature" });
});

export default router;
