import express from "express";
import crypto from "crypto";
import Order from "../models/Order.js";
import { createBillFromData } from "../lib/billing.js";
import { confirmAndFinalizeOrder } from "./orderRoutes.js";
import cashfree from "../lib/cashfree.js";

const router = express.Router();

router.post("/cashfree", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"] || req.headers["x-cf-signature"];
    const timestamp = req.headers["x-webhook-timestamp"] || "";
    
    // Get raw body string for cryptographic signature verification
    let rawBodyStr = "";
    if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
      rawBodyStr = req.rawBody.toString("utf8");
    } else if (typeof req.body === "string") {
      rawBodyStr = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      rawBodyStr = req.body.toString("utf8");
    } else {
      rawBodyStr = JSON.stringify(req.body || {});
    }

    // Parse payload safely
    let payload = (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) ? req.body : null;
    if (!payload && rawBodyStr) {
      try {
        payload = JSON.parse(rawBodyStr);
      } catch (e) {
        console.error("Cashfree webhook JSON parse error:", e);
      }
    }

    const secret = process.env.CASHFREE_SECRET_KEY;
    let isSignatureValid = false;

    if (signature && secret && rawBodyStr) {
      // 1. Standard Cashfree PG Webhook (timestamp + rawBody)
      const expectedSigWithTs = crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}${rawBodyStr}`)
        .digest("base64");

      // 2. Legacy / alternative signature (rawBody only)
      const expectedSigNoTs = crypto
        .createHmac("sha256", secret)
        .update(rawBodyStr)
        .digest("base64");

      if (signature === expectedSigWithTs || signature === expectedSigNoTs) {
        isSignatureValid = true;
      }
    }

    const orderId = payload?.data?.order?.order_id || payload?.data?.orderId || payload?.order_id || payload?.orderId;
    const eventType = payload?.type || payload?.event || "";

    // 3. Fallback verification: Server-to-server check directly with Cashfree's authoritative API
    // This ensures that even if header format or signature calculation differs, a paid order is NEVER lost!
    if (!isSignatureValid && orderId) {
      try {
        const { data: cfOrder } = await cashfree.get(`/pg/orders/${orderId}`);
        if (cfOrder && (cfOrder.order_status === "PAID" || cfOrder.order_status === "SUCCESS")) {
          console.log(`[Cashfree Webhook] Verified directly with Cashfree API for order: ${orderId}`);
          isSignatureValid = true;
        }
      } catch (apiErr) {
        console.warn(`[Cashfree Webhook] API fallback verification failed for ${orderId}:`, apiErr.message);
      }
    }

    if (!isSignatureValid) {
      console.warn("[Cashfree Webhook] Invalid signature and API verification failed. Rejecting.");
      return res.status(400).json({ error: "invalid_signature" });
    }

    // Handle Payment Success
    const isPaymentSuccess = 
      eventType === "PAYMENT_SUCCESS_WEBHOOK" ||
      eventType === "PAYMENT_SUCCESS" || 
      eventType === "ORDER_PAID" ||
      payload?.data?.payment?.payment_status === "SUCCESS";

    if (isPaymentSuccess && orderId) {
      const order = await Order.findOne({ cashfreeOrderId: orderId });
      if (order && order.paymentStatus !== "PAID") {
        const cfPaymentId = payload?.data?.payment?.cf_payment_id || payload?.data?.payment?.payment_id || "";
        const cfSignature = payload?.data?.payment?.payment_signature || "";
        console.log(`[Cashfree Webhook] Finalizing order ${orderId} (DB ID: ${order._id})...`);
        await confirmAndFinalizeOrder(order, cfPaymentId, cfSignature);
      } else if (order) {
        console.log(`[Cashfree Webhook] Order ${orderId} is already PAID.`);
      } else {
        console.warn(`[Cashfree Webhook] Order ${orderId} not found in DB.`);
      }
    }

    // Handle Refund Events
    const isRefundSuccess = eventType === "REFUND_SUCCESS" || payload?.data?.refund;
    if (isRefundSuccess && payload?.data?.refund) {
      const refundOrderId = payload.data.refund.order_id;
      const refundStatus = payload.data.refund.refund_status;
      
      const order = await Order.findOne({ cashfreeOrderId: refundOrderId });
      if (order) {
        if (refundStatus === "SUCCESS") {
          order.refundStatus = "SUCCESS";
        } else if (refundStatus === "FAILED") {
          order.refundStatus = "FAILED";
        }
        await order.save();
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Cashfree webhook error:", err);
    return res.status(400).json({ error: "invalid_payload" });
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
