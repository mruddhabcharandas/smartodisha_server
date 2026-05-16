import mongoose from "mongoose";

const cartItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variantSku: { type: String }, // Phase 5 requirement
    quantity: { type: Number, required: true, min: 1 },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const cartSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, unique: true },
    items: { type: [cartItemSchema], default: [] }
  },
  { timestamps: true }
);

cartSchema.index({ customer: 1 }, { unique: true });

export default mongoose.models.Cart || mongoose.model("Cart", cartSchema);
