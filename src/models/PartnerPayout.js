import mongoose from "mongoose";

const partnerPayoutSchema = new mongoose.Schema(
  {
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", required: true },
    couponCode: { type: String, required: true, uppercase: true, trim: true },
    amount: { type: Number, required: true },
    method: { type: String, enum: ["MANUAL", "RAZORPAY"], default: "MANUAL" },
    utr: { type: String, default: "" },
    razorpayPaymentId: { type: String, default: "" },
    notes: { type: String, default: "" },
    status: { type: String, enum: ["PAID"], default: "PAID" }
  },
  { timestamps: true }
);

partnerPayoutSchema.index({ couponCode: 1, createdAt: -1 });

export default mongoose.models.PartnerPayout || mongoose.model("PartnerPayout", partnerPayoutSchema);

