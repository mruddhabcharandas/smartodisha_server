import express from "express";
import crypto from "crypto";
import Order from "../models/Order.js";
import { createBillFromData } from "../lib/billing.js";

const router = express.Router();

router.post("/razorpay", express.raw({ type: "*/*" }), async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const body = req.body;
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: "missing_webhook_secret" });

  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.body)
    .digest("hex");

  if (expected !== signature) return res.status(400).json({ error: "invalid_signature" });

  try {
    const payload = JSON.parse(body.toString());
    const event = payload?.event;
    if (event === "order.paid" || event === "payment.captured") {
      const razorpayOrderId = payload?.payload?.payment?.entity?.order_id || payload?.payload?.order?.entity?.id;
      if (razorpayOrderId) {
        const order = await Order.findOne({ razorpayOrderId });
        if (order && order.paymentStatus !== "PAID") {
          order.paymentStatus = "PAID";
          order.status = "CONFIRMED";
          await order.save();
          try {
            await createBillFromData({
              customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
              items: order.items.map(it => ({ product: it.product, quantity: it.quantity })),
              paymentType: "RAZORPAY",
              existingOrderId: order._id
            });
          } catch {}
        }
      }
    }
  } catch {
    return res.status(400).json({ error: "invalid_payload" });
  }
  res.json({ received: true });
});

export default router;
