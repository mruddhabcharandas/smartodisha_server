import express from "express";
import crypto from "crypto";
import Order from "../models/Order.js";
import { createBillFromData } from "../lib/billing.js";
import { confirmAndFinalizeOrder } from "./orderRoutes.js";

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
        const cfPaymentId = payload.data.payment?.cf_payment_id || "";
        const cfSignature = payload.data.payment?.payment_signature || "";
        await confirmAndFinalizeOrder(order, cfPaymentId, cfSignature);
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

// Delhivery Webhook Receiver
router.post("/delhivery", async (req, res) => {
  try {
    const payload = req.body;
    console.log("[Delhivery Webhook] Received update at /api/webhooks/delhivery:", JSON.stringify(payload, null, 2));

    const { updateOrderWithDelhiveryStatus } = await import("../services/delhiveryTrackingSync.js");

    let items = [];
    if (Array.isArray(payload)) {
      items = payload;
    } else if (Array.isArray(payload?.ShipmentData)) {
      items = payload.ShipmentData.map(s => s.Shipment || s);
    } else if (Array.isArray(payload?.shipments)) {
      items = payload.shipments;
    } else if (payload) {
      items = [payload];
    }

    let updatedCount = 0;

    for (const item of items) {
      const waybill = item.waybill || item.Waybill || item.awb || item.AWB || item.wbn;
      const orderRef = item.order || item.Order || item.order_id || item.orderId;

      let rawStatus = "";
      if (typeof item.status === "string") rawStatus = item.status;
      else if (typeof item.Status === "string") rawStatus = item.Status;
      else if (item.Status?.Status) rawStatus = item.Status.Status;
      else if (item.Status?.Instructions) rawStatus = item.Status.Instructions;
      else if (item.CurrentStatus) rawStatus = item.CurrentStatus;
      else if (item.status?.status) rawStatus = item.status.status;

      if (!waybill && !orderRef) continue;

      const filter = [];
      if (waybill) {
        filter.push({ "shipping.waybill": waybill });
        filter.push({ delhiveryWaybill: waybill });
      }
      if (orderRef) {
        const mongoose = (await import("mongoose")).default;
        if (mongoose.isValidObjectId(orderRef)) {
          filter.push({ _id: orderRef });
        }
        filter.push({ orderNumber: orderRef });
      }

      const order = await Order.findOne({ $or: filter });
      if (order && rawStatus) {
        const syncRes = await updateOrderWithDelhiveryStatus(order, rawStatus, {
          waybill: waybill || order.shipping?.waybill,
          location: item.location || item.StatusLocation,
          timestamp: item.timestamp || item.StatusDateTime
        });
        if (syncRes.hasChanged) updatedCount++;
      }
    }

    res.status(200).json({ success: true, processed: items.length, updated: updatedCount });
  } catch (err) {
    console.error("[Delhivery Webhook] Error:", err);
    res.status(400).json({ error: "webhook_processing_failed", message: err.message });
  }
});

export default router;
