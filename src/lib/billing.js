import mongoose from "mongoose";
import Customer from "../models/Customer.js";
import Product from "../models/Product.js";
import Bill from "../models/Bill.js";
import Order from "../models/Order.js";
import StockTxn from "../models/StockTxn.js";
import Coupon from "../models/Coupon.js";
import { computeTotals, generateInvoiceNumber } from "./invoice.js";
import { sendLowStockEmail } from "./notifications.js";

const lowStockAlertCache = new Set(); // Track product IDs that recently triggered an alert

export const createBillFromData = async ({ customerData, items, paymentType, couponCode, existingOrderId }) => {
  if (!Array.isArray(items) || items.length === 0) throw new Error("no_items");

  let cust;
  if (customerData.id) {
    cust = await Customer.findOne({ _id: customerData.id, isActive: true });
  } else {
    const phone = String(customerData.phone).trim();
    cust = await Customer.findOne({ phone });
    if (!cust) {
      cust = await Customer.create({
        name: String(customerData.name).trim(),
        phone,
        email: customerData.email || undefined,
        address: customerData.address || "",
        isVerified: false // Admin created customers are not verified by default
      });
    }
  }
  if (!cust) throw new Error("customer_not_found");

  const ids = items.map((x) => x.productId || x.product);
  const products = await Product.find({ _id: { $in: ids }, isActive: true });
  
  // Re-verify stock
  for (const it of items) {
    const p = products.find((x) => (x._id || x.productId).toString() === (it.productId || it.product).toString());
    const qty = Number(it.quantity);
    if (!p) throw new Error(`insufficient_stock:unknown`);
    if (it.variantSku) {
      const v = (p.variants || []).find(v => v.sku === String(it.variantSku));
      if (!v || (v.stock || 0) < qty) throw new Error(`insufficient_stock:${p.name}`);
    } else {
      if (p.stock < qty) throw new Error(`insufficient_stock:${p.name}`);
    }
  }

  const totals = computeTotals(products, items.map(it => ({ ...it, productId: it.productId || it.product, variantSku: it.variantSku })));
  const billItems = totals.items.map(it => {
    const p = products.find(x => x._id.toString() === it.product.toString());
    const v = it.variantSku ? (p?.variants || []).find(v => v.sku === String(it.variantSku)) : null;
    const image = v?.images?.[0]?.url || p?.images?.[0]?.url || "";
    return { ...it, image, hsn: p?.hsnCode || "" };
  });

  let discount = 0;
  let appliedCoupon = null;
  if (couponCode) {
    const code = String(couponCode).trim().toUpperCase();
    const c = await Coupon.findOne({ code, isActive: true });
    if (c) {
      discount = c.type === "PERCENT" ? (totals.total * c.value) / 100 : c.value;
      if (discount > totals.total) discount = totals.total;
      appliedCoupon = c;
    }
  }

  const invoiceNumber = await generateInvoiceNumber();
  const session = await mongoose.startSession();
  let billDoc;

  try {
    await session.withTransaction(async () => {
      for (const it of items) {
        const p = products.find((x) => (x._id || x.productId).toString() === (it.productId || it.product).toString());
        if (it.variantSku) {
          const idx = (p.variants || []).findIndex(v => v.sku === String(it.variantSku));
          const before = p.variants[idx]?.stock || 0;
          p.variants[idx].stock = before - Number(it.quantity);
          // Recalculate total product stock
          p.stock = (p.variants || []).filter(v => v.isActive !== false).reduce((s, v) => s + (v.stock || 0), 0);
          await p.save({ session });
          await StockTxn.create([
            {
              product: p._id,
              type: "SOLD",
              quantity: Number(it.quantity),
              before,
              after: p.variants[idx].stock,
              refType: "BILL",
              refId: invoiceNumber,
              variantSku: String(it.variantSku)
            }
          ], { session });
        } else {
          await Product.updateOne(
            { _id: p._id, stock: { $gte: it.quantity } },
            { $inc: { stock: -Number(it.quantity) } },
            { session }
          );
          await StockTxn.create([
            {
              product: p._id,
              type: "SOLD",
              quantity: Number(it.quantity),
              before: p.stock,
              after: p.stock - Number(it.quantity),
              refType: "BILL",
              refId: invoiceNumber
            }
          ], { session });
        }
      }

      const bills = await Bill.create(
        [
          {
            invoiceNumber,
            customer: cust._id,
            items: billItems,
            subtotal: totals.subtotal,
            gstTotal: totals.gstTotal,
            total: totals.total,
            discount: Number(discount.toFixed(2)),
            payable: Number((totals.total - discount).toFixed(2)),
            couponCode: appliedCoupon ? appliedCoupon.code : undefined,
            gstBreakdown: totals.gstBreakdown,
            paymentType: paymentType || "CASH"
          }
        ],
        { session }
      );
      billDoc = bills[0];

      await Customer.updateOne({ _id: cust._id }, { $push: { purchaseHistory: billDoc._id } }, { session });

      if (existingOrderId) {
        await Order.findByIdAndUpdate(existingOrderId, { 
          billId: billDoc._id, 
          status: "FULFILLED",
          notes: `Auto-billed: ${invoiceNumber}` 
        }, { session });
      } else {
        await Order.create([{
          type: "BILL",
          billId: billDoc._id,
          customer: { name: cust.name, phone: cust.phone, email: cust.email || "" },
          items: billItems,
          totalEstimate: billDoc.payable,
          status: "FULFILLED",
          notes: `Direct Bill: ${invoiceNumber}`
        }], { session });
      }

      if (appliedCoupon) {
        await Coupon.updateOne({ _id: appliedCoupon._id }, { $inc: { usedCount: 1 } }, { session });
      }
    });
  } finally {
    session.endSession();
  }

  // Stock notification
  try {
    const threshold = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);
    const affectedProducts = await Product.find({ 
      _id: { $in: ids }, 
      isActive: true 
    });
    
    const alerts = [];
    affectedProducts.forEach(p => {
      if (p.variants && p.variants.length > 0) {
        p.variants.forEach(v => {
          if (v.isActive !== false && v.stock <= threshold) {
            const alertId = `${p._id}_${v.sku}`;
            if (!lowStockAlertCache.has(alertId)) {
              alerts.push({ 
                _id: p._id, 
                name: `${p.name} (${v.sku || 'No SKU'})`, 
                stock: v.stock,
                alertId 
              });
            }
          }
        });
      } else if (p.stock <= threshold) {
        if (!lowStockAlertCache.has(p._id.toString())) {
          alerts.push({ 
            _id: p._id, 
            name: p.name, 
            stock: p.stock,
            alertId: p._id.toString() 
          });
        }
      }
    });
    
    if (alerts.length > 0) {
      await sendLowStockEmail(alerts, threshold);
      // Mark as alerted
      alerts.forEach(a => {
        lowStockAlertCache.add(a.alertId);
        // Clear from cache after 1 hour
        setTimeout(() => lowStockAlertCache.delete(a.alertId), 60 * 60 * 1000);
      });
    }
  } catch (err) { console.error("Notification failed", err); }

  return billDoc;
};
