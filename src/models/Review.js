import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: "" }
  },
  { timestamps: true }
);

reviewSchema.index({ product: 1, customer: 1 }, { unique: true });

export default mongoose.models.Review || mongoose.model("Review", reviewSchema);
