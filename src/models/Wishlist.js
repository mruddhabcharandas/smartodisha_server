import mongoose from "mongoose";

const wishlistItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const wishlistSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, unique: true },
    items: { type: [wishlistItemSchema], default: [] }
  },
  { timestamps: true }
);

wishlistSchema.index({ customer: 1 }, { unique: true });

export default mongoose.models.Wishlist || mongoose.model("Wishlist", wishlistSchema);
