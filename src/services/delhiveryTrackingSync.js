import Order from "../models/Order.js";
import AuditLog from "../models/AuditLog.js";
import * as delhivery from "./delhivery.service.js";
import { notifyAdmin } from "../lib/socket.js";
import { createBillFromData } from "../lib/billing.js";
import { creditSellerWalletForOrder } from "../routes/orderRoutes.js";
import { sendEmail, renderMail, sendCustomerOrderStatusUpdateEmail } from "../lib/mailer.js";

/**
 * Maps raw Delhivery status text / code to internal Order status enum:
 * ["PENDING", "PENDING_PAYMENT", "CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RETURNED"]
 */
export const mapDelhiveryStatusToOrderStatus = (rawStatus = "") => {
  if (!rawStatus) return null;
  const s = String(rawStatus).trim().toLowerCase();

  // 1. Delivered / Consignee Receipt
  if (
    (s.includes("deliver") && !s.includes("undeliver") && !s.includes("out for deliver") && !s.includes("attempt") && !s.includes("rto deliver")) ||
    s === "dl" ||
    s === "del" ||
    s.includes("delivered to consignee")
  ) {
    return "DELIVERED";
  }

  // 2. Out for delivery
  if (
    s.includes("out for delivery") ||
    s.includes("out for deliver") ||
    s.includes("dispatched for delivery") ||
    s === "ofd"
  ) {
    return "OUT_FOR_DELIVERY";
  }

  // 3. Returned / RTO / DTO
  if (
    s.includes("rto") ||
    s.includes("dto") ||
    s.includes("return to origin") ||
    s.includes("returned to seller") ||
    s.includes("returned to shipper") ||
    s === "rt"
  ) {
    return "RETURNED";
  }

  // 4. Cancelled
  if (
    s.includes("cancel") ||
    s.includes("canceled") ||
    s.includes("cancelled by client") ||
    s === "cn"
  ) {
    return "CANCELLED";
  }

  // 5. In transit / Shipped / Manifested
  if (
    s.includes("manifest") ||
    s.includes("in transit") ||
    s.includes("in-transit") ||
    s.includes("dispatched") ||
    s.includes("picked up") ||
    s.includes("pickup done") ||
    s.includes("pickup scheduled") ||
    s.includes("pending pickup") ||
    s.includes("arrived") ||
    s.includes("reached") ||
    s.includes("hub") ||
    s.includes("center") ||
    s.includes("transit") ||
    s.includes("shipped")
  ) {
    return "SHIPPED";
  }

  // 6. Packed
  if (s.includes("packed") || s.includes("bagged")) {
    return "PACKED";
  }

  return null;
};

/**
 * Hierarchy level of order statuses to prevent backward transitions from final states
 */
const STATUS_HIERARCHY = {
  PENDING: 1,
  PENDING_PAYMENT: 1,
  CONFIRMED: 2,
  PROCESSING: 2,
  PACKED: 3,
  SHIPPED: 4,
  OUT_FOR_DELIVERY: 5,
  DELIVERED: 6,
  RETURNED: 7,
  CANCELLED: 8
};

/**
 * Updates a single order with Delhivery tracking status
 */
export const updateOrderWithDelhiveryStatus = async (orderOrId, rawDelhiveryStatus, meta = {}) => {
  try {
    let order = orderOrId;
    if (typeof orderOrId === "string" || orderOrId instanceof String) {
      order = await Order.findById(orderOrId);
    }
    if (!order) return { success: false, error: "Order not found" };

    const cleanRawStatus = String(rawDelhiveryStatus || "").trim();
    if (!cleanRawStatus) return { success: false, error: "Empty status" };

    let hasChanged = false;
    const previousOrderStatus = order.status;
    const previousShippingStatus = order.shipping?.status || "";

    // 1. Always update shipping status string
    if (!order.shipping) {
      order.shipping = { provider: "DELHIVERY" };
    }
    if (order.shipping.status !== cleanRawStatus) {
      order.shipping.status = cleanRawStatus;
      order.shipment_status = cleanRawStatus;
      hasChanged = true;
    }

    if (meta.waybill && !order.shipping.waybill) {
      order.shipping.waybill = meta.waybill;
      order.delhiveryWaybill = meta.waybill;
      order.shipping.trackingUrl = `https://www.delhivery.com/track/package/${meta.waybill}`;
      hasChanged = true;
    }

    // 2. Map to internal Order status
    const targetStatus = mapDelhiveryStatusToOrderStatus(cleanRawStatus);

    if (targetStatus && targetStatus !== order.status) {
      // Prevent downgrade if order is already marked DELIVERED or CANCELLED, unless it is RTO
      const currentLevel = STATUS_HIERARCHY[order.status] || 0;
      const targetLevel = STATUS_HIERARCHY[targetStatus] || 0;

      const isAllowedTransition =
        order.status !== "DELIVERED" || targetStatus === "RETURNED" || targetStatus === "CANCELLED";

      if (isAllowedTransition && (targetLevel >= currentLevel || targetStatus === "CANCELLED" || targetStatus === "RETURNED")) {
        console.log(`[Delhivery Sync] Order ${order.orderNumber || order._id}: ${order.status} -> ${targetStatus} (via Delhivery: "${cleanRawStatus}")`);
        order.status = targetStatus;
        hasChanged = true;

        // Trigger Customer Status Emails based on tracking
        if (targetStatus === "SHIPPED") {
          sendCustomerOrderStatusUpdateEmail(order, "SHIPPED").catch(err => {
            console.warn(`[Delhivery Sync] Shipped email error:`, err.message);
          });
        } else if (targetStatus === "OUT_FOR_DELIVERY") {
          sendCustomerOrderStatusUpdateEmail(order, "OUT_FOR_DELIVERY").catch(err => {
            console.warn(`[Delhivery Sync] Out for delivery email error:`, err.message);
          });
        } else if (targetStatus === "DELIVERED") {
          order.paymentStatus = "PAID";

          // Credit seller wallet
          try {
            await creditSellerWalletForOrder(order._id);
          } catch (walletErr) {
            console.error(`[Delhivery Sync] Seller wallet credit error for order ${order._id}:`, walletErr.message);
          }

          // Generate bill if missing
          try {
            await createBillFromData({
              customerData: { phone: order.customer.phone, name: order.customer.name, email: order.customer.email },
              items: order.items.map(it => ({ product: it.product, variantSku: it.variantSku || undefined, quantity: it.quantity })),
              paymentType: order.paymentMethod,
              existingOrderId: order._id
            });
          } catch (billingErr) {
            // Ignore if bill already exists or stock handled
          }

          // Send Luxury Delivery Confirmation Email
          sendCustomerOrderStatusUpdateEmail(order, "DELIVERED").catch(mailErr => {
            console.warn(`[Delhivery Sync] Delivery email notification failed:`, mailErr.message);
          });
        }
      }
    }

    if (hasChanged) {
      await order.save();

      // Audit Log
      try {
        await AuditLog.create({
          actorId: null,
          actorRole: "delhivery",
          type: "ORDER_STATUS",
          entityType: "ORDER",
          entityId: order._id.toString(),
          note: `Delhivery status synced: "${cleanRawStatus}". Order status: ${previousOrderStatus} -> ${order.status}`
        });
      } catch {}

      // Socket notification to Admin room
      notifyAdmin("order_status_updated", {
        orderId: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        delhiveryStatus: cleanRawStatus,
        waybill: order.shipping?.waybill
      });
    }

    return {
      success: true,
      hasChanged,
      orderId: order._id,
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      delhiveryStatus: cleanRawStatus,
      waybill: order.shipping?.waybill
    };
  } catch (err) {
    console.error("[Delhivery Sync] Update error:", err);
    return { success: false, error: err.message };
  }
};

/**
 * Queries Delhivery Tracking API for a given order and updates database directly
 */
export const syncOrderDelhiveryStatus = async (orderOrId) => {
  try {
    let order = orderOrId;
    if (typeof orderOrId === "string" || orderOrId instanceof String) {
      order = await Order.findById(orderOrId);
    }
    if (!order) return { success: false, error: "Order not found" };

    const waybill = order.shipping?.waybill || order.delhiveryWaybill;
    if (!waybill) {
      return { success: false, error: "Order does not have a Delhivery waybill number" };
    }

    const trackingResult = await delhivery.trackShipment(waybill);
    const rawStatus = trackingResult.status || "";

    if (!rawStatus || rawStatus === "Not Found" || rawStatus === "Unknown") {
      return {
        success: true,
        updated: false,
        message: "No new tracking scan available from Delhivery",
        raw: trackingResult
      };
    }

    const updateRes = await updateOrderWithDelhiveryStatus(order, rawStatus, {
      waybill,
      location: trackingResult.location,
      timestamp: trackingResult.timestamp,
      statusCode: trackingResult.statusCode
    });

    return {
      ...updateRes,
      tracking: trackingResult
    };
  } catch (err) {
    console.error(`[Delhivery Sync] Failed to sync order:`, err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Syncs all active Delhivery orders currently in fulfillment
 */
export const syncAllActiveDelhiveryOrders = async () => {
  try {
    const activeOrders = await Order.find({
      $or: [
        { "shipping.waybill": { $exists: true, $ne: "" } },
        { delhiveryWaybill: { $exists: true, $ne: "" } }
      ],
      status: { $in: ["CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY"] }
    }).limit(100);

    if (activeOrders.length === 0) {
      return { total: 0, updated: 0, message: "No active shipments to sync" };
    }

    console.log(`[Delhivery Poller] Syncing ${activeOrders.length} active shipments from Delhivery...`);

    let updatedCount = 0;
    for (const order of activeOrders) {
      try {
        const res = await syncOrderDelhiveryStatus(order);
        if (res.hasChanged) {
          updatedCount++;
        }
        // Small delay to be polite to Delhivery API rate limits
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        console.warn(`[Delhivery Poller] Error syncing order ${order._id}:`, e.message);
      }
    }

    console.log(`[Delhivery Poller] Completed: ${updatedCount}/${activeOrders.length} orders updated.`);
    return { total: activeOrders.length, updated: updatedCount };
  } catch (err) {
    console.error("[Delhivery Poller] Global sync failed:", err);
    return { error: err.message };
  }
};

export default {
  mapDelhiveryStatusToOrderStatus,
  updateOrderWithDelhiveryStatus,
  syncOrderDelhiveryStatus,
  syncAllActiveDelhiveryOrders
};
