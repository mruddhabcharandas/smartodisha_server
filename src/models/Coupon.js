import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: ["PERCENT", "FLAT"], required: true },
    value: { type: Number, required: true },
    minAmount: { type: Number, default: 0 },
    expiryDate: { type: Date, required: true },
    usageLimit: { type: Number, default: 0 },
    usedCount: { type: Number, default: 0 },
    maxDiscount: { type: Number, default: 0 }, // 0 = no max
    minOrderValue: { type: Number, default: 0 }, // min amount to apply
    isActive: { type: Boolean, default: true },
    isPublic: { type: Boolean, default: true }, // Show to users in checkout
    partner: { type: mongoose.Schema.Types.ObjectId, ref: "Partner" },
    partnerName: { type: String, default: "" },
    partnerEmail: { type: String, default: "" },
    partnerPhone: { type: String, default: "" },
    partnerCommissionPercent: { type: Number, default: 0 },
    maxTotalSales: { type: Number, default: 0 }, // 0 = unlimited
    totalSales: { type: Number, default: 0 },
    password: { type: String, trim: true }, // Added for partner portal security
    otp: { type: String },
    otpExpiry: { type: Date }
  },
  { timestamps: true }
);

couponSchema.index({ code: 1 }, { unique: true });

export default mongoose.models.Coupon || mongoose.model("Coupon", couponSchema);

