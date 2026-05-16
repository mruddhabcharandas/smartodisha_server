import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Customer from "../models/Customer.js";
import Product from "../models/Product.js";
import Bill from "../models/Bill.js";
import { computeTotals, generateInvoiceNumber } from "../lib/invoice.js";
import { streamInvoicePDF } from "../lib/pdf.js";
import { renderInvoiceHTML } from "../lib/invoiceHtml.js";
import Order from "../models/Order.js";
import { createBillFromData } from "../lib/billing.js";
import { sendEmail } from "../lib/mailer.js";
import { delCache } from "../lib/redis.js";

const router = express.Router();

router.post("/", auth, requireRole("admin"), async (req, res) => {
  try {
    const { customerId, customer, items, paymentType, couponCode } = req.body || {};
    const billDoc = await createBillFromData({
      customerData: customerId ? { id: customerId } : customer,
      items,
      paymentType,
      couponCode
    });
    const populated = await Bill.findById(billDoc._id).populate("customer");
    
    // Clear all partner summaries as a new bill might affect them
    await delCache("partner:summary:*");
    
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:id", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const bill = await Bill.findById(req.params.id).populate("customer");
  if (!bill) return res.status(404).json({ error: "not_found" });
  res.json(bill);
});

router.get("/search", auth, requireRole("admin"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  const bills = await Bill.find({
    $or: [
      { invoiceNumber: { $regex: q, $options: "i" } },
      { couponCode: { $regex: q, $options: "i" } }
    ]
  })
    .limit(20)
    .sort({ createdAt: -1 })
    .populate("customer");
  res.json(bills);
});

router.get("/:id/pdf", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const bill = await Bill.findById(req.params.id).populate("customer");
  if (!bill) return res.status(404).json({ error: "not_found" });
  streamInvoicePDF(res, bill, bill.customer);
});

router.get("/:id/html", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const bill = await Bill.findById(req.params.id).populate("customer");
  if (!bill) return res.status(404).json({ error: "not_found" });
  const order = await Order.findOne({ billId: bill._id }).lean();
  const html = renderInvoiceHTML(bill.toObject(), bill.customer?.toObject(), order);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

router.post("/:id/send-email", auth, requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "invalid_id" });
  const bill = await Bill.findById(req.params.id).populate("customer");
  if (!bill) return res.status(404).json({ error: "not_found" });
  if (!bill.customer?.email) return res.status(400).json({ error: "customer_email_missing" });

  const order = await Order.findOne({ billId: bill._id }).lean();
  const html = renderInvoiceHTML(bill.toObject(), bill.customer?.toObject(), order, {
    name: process.env.COMPANY_NAME,
    email: process.env.COMPANY_EMAIL
  });
  const pdfLink = `${process.env.CLIENT_API_URL || process.env.API_URL || "http://localhost:5000"}/api/bills/${bill._id}/pdf`;

  try {
    await sendEmail({
      to: bill.customer.email,
      subject: `Invoice ${bill.invoiceNumber || bill._id} - ${process.env.COMPANY_NAME || "Click2Kart"}`,
      html: `
        <div style="font-family: ui-sans-serif, system-ui; max-width: 680px; margin: auto; padding: 24px; border: 1px solid #eee; border-radius: 12px;">
          <h2 style="color:#111827;margin:0 0 12px;font-weight:800">Your Invoice ${bill.invoiceNumber || bill._id}</h2>
          <p style="color:#374151;line-height:1.6">Hi ${bill.customer.name}, please find your invoice details below. You can download the PDF using the button.</p>
          <div style="margin:16px 0;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
            <div style="font-weight:800;color:#111827">Amount Payable: ₹${(bill.payable || bill.total).toLocaleString("en-IN")}</div>
            <div style="color:#6b7280;font-size:12px">Invoice Date: ${new Date(bill.date || bill.createdAt).toLocaleDateString("en-IN")}</div>
          </div>
          <a href="${pdfLink}" style="display:inline-block;margin:8px 0 16px;padding:12px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">Download PDF</a>
          <div style="margin-top:16px;border-top:1px solid #eee;padding-top:12px">
            <div style="font-size:12px;color:#6b7280">&copy; ${new Date().getFullYear()} ${process.env.COMPANY_NAME || "Click2Kart"} • This is an automated email.</div>
          </div>
        </div>
      `
    });
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: "mail_failed" });
  }
});

export default router;
