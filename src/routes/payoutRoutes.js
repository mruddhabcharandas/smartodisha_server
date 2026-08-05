import express from "express";
import Store from "../models/Store.js";
import SellerTransaction from "../models/SellerTransaction.js";
import { auth, requireRole, requirePermission } from "../middleware/auth.js";
import mongoose from "mongoose";

const router = express.Router();

// Get all store payout details (Admin only)
router.get("/", auth, requirePermission("orders"), async (req, res) => {
  try {
    const stores = await Store.find({}, "name image email phone walletPending walletPaid createdAt").lean();
    res.json(stores);
  } catch (err) {
    console.error("Get payouts failed:", err);
    res.status(500).json({ error: "payouts_fetch_failed", message: err.message });
  }
});

// Process a payout to a seller (Admin only)
router.post("/pay", auth, requirePermission("orders"), async (req, res) => {
  const { storeId, amount, note, referenceId } = req.body;
  if (!mongoose.isValidObjectId(storeId)) return res.status(400).json({ error: "invalid_store_id" });

  const payoutAmount = Number(amount);
  if (isNaN(payoutAmount) || payoutAmount <= 0) {
    return res.status(400).json({ error: "invalid_amount", message: "Payout amount must be greater than zero." });
  }

  try {
    const store = await Store.findById(storeId);
    if (!store) return res.status(404).json({ error: "store_not_found" });

    // Update store balance
    store.walletPending = Math.max(0, store.walletPending - payoutAmount);
    store.walletPaid += payoutAmount;
    await store.save();

    // Log the transaction
    const tx = await SellerTransaction.create({
      store: storeId,
      type: "PAYOUT",
      amount: payoutAmount,
      referenceId: referenceId || "",
      note: note || "Payout from Admin"
    });

    res.json({ success: true, message: "Payout processed successfully", transaction: tx, store });
  } catch (err) {
    console.error("Process payout failed:", err);
    res.status(500).json({ error: "payout_failed", message: err.message });
  }
});

// Process a wallet deduction for a seller (Admin only)
router.post("/deduct", auth, requirePermission("orders"), async (req, res) => {
  const { storeId, amount, note, proofImage } = req.body;
  if (!mongoose.isValidObjectId(storeId)) return res.status(400).json({ error: "invalid_store_id" });

  const deductAmount = Number(amount);
  if (isNaN(deductAmount) || deductAmount <= 0) {
    return res.status(400).json({ error: "invalid_amount", message: "Deduction amount must be greater than zero." });
  }

  try {
    const store = await Store.findById(storeId);
    if (!store) return res.status(404).json({ error: "store_not_found" });

    // Update store balance (allow negative pending balance for deductions)
    store.walletPending = (store.walletPending || 0) - deductAmount;
    await store.save();

    // Log the transaction
    const tx = await SellerTransaction.create({
      store: storeId,
      type: "DEDUCTION",
      amount: deductAmount,
      note: note || "Wallet deduction by Admin",
      proofImage: proofImage || ""
    });

    res.json({ success: true, message: "Deduction processed successfully", transaction: tx, store });
  } catch (err) {
    console.error("Process deduction failed:", err);
    res.status(500).json({ error: "deduction_failed", message: err.message });
  }
});

// Get all seller transactions (Admin only)
router.get("/transactions", auth, requirePermission("orders"), async (req, res) => {
  try {
    const txs = await SellerTransaction.find()
      .populate("store", "name email phone")
      .populate("order", "_id totalEstimate customer")
      .sort({ createdAt: -1 })
      .lean();
    res.json(txs);
  } catch (err) {
    console.error("Get transactions failed:", err);
    res.status(500).json({ error: "transactions_fetch_failed", message: err.message });
  }
});

export default router;
