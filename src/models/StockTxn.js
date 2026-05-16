import mongoose from "mongoose";

const stockTxnSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    type: { type: String, enum: ["SOLD", "ADDED", "ADJUST"], required: true },
    quantity: { type: Number, required: true },
    before: { type: Number, required: true },
    after: { type: Number, required: true },
    refType: { type: String, enum: ["BILL", "MANUAL", "ORDER"], default: "MANUAL" },
    refId: { type: String, default: "" },
    variantSku: { type: String, default: "" }, // Phase 6 requirement
    note: { type: String, default: "" }
  },
  { timestamps: true }
);

export default mongoose.models.StockTxn || mongoose.model("StockTxn", stockTxnSchema);

