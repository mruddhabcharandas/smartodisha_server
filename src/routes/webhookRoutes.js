import express from "express";
import crypto from "crypto";
import Order from "../models/Order.js";
import { createBillFromData } from "../lib/billing.js";

const router = express.Router();

router.post("/cashfree", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];
    const body = req.body.toString();
    
    const expectedSignature = crypto
      .createHmac("sha256", process.env.CASHFREE_SECRET_KEY)
      .update(body)
      .digest("base64");
    
    if (expectedSignature !== signature) {
      return res.status(400).json({ error: "invalid_signature" });
    }

    const payload = JSON.parse(body);
    const eventType = payload.type;

    // Handle payment success
    if ((eventType === "PAYMENT_SUCCESS" || eventType === "ORDER_PAID") && payload.data?.order) {
      const orderId = payload.data.order.order_id;
      const order = await Order.findOne({ cashfreeOrderId: orderId });
      if (order && order.paymentStatus !== "PAID") {
        order.paymentStatus = "PAID";
        order.status = "CONFIRMED";
        await order.save();
        try {
          await createBillFromData({
            customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
            items: order.items.map(it => ({ product: it.product, quantity: it.quantity })),
            paymentType: "CASHFREE",
            existingOrderId: order._id
          });
        } catch {}
      }
    }

    // Handle refund events
    if (eventType === "REFUND_SUCCESS" && payload.data?.refund) {
      const refundId = payload.data.refund.refund_id;
      const orderId = payload.data.refund.order_id;
      const refundStatus = payload.data.refund.refund_status;
      
      const order = await Order.findOne({ cashfreeOrderId: orderId });
      if (order) {
        if (refundStatus === "SUCCESS") {
          order.refundStatus = "SUCCESS";
        } else if (refundStatus === "FAILED") {
          order.refundStatus = "FAILED";
        }
        await order.save();
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Cashfree webhook error:", err);
    res.status(400).json({ error: "invalid_payload" });
  }
});

export default router;
