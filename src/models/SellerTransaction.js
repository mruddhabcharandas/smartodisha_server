import mongoose from "mongoose";

const sellerTransactionSchema = new mongoose.Schema(
  {
    store: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true
    },
    type: {
      type: String,
      enum: ["EARNING", "PAYOUT"],
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order"
    },
    referenceId: {
      type: String,
      default: ""
    },
    note: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

export default mongoose.model("SellerTransaction", sellerTransactionSchema);
