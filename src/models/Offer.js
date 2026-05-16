import mongoose from "mongoose";

const offerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    bannerImage: { type: String, required: true },
    discountPercent: { type: Number, default: 0 },
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export default mongoose.models.Offer || mongoose.model("Offer", offerSchema);
