import mongoose from "mongoose";

const partnerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, default: "", trim: true, unique: true },
    phone: { type: String, default: "", trim: true },
    password: { type: String, trim: true },
    otp: { type: String },
    otpExpiry: { type: Date },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

partnerSchema.index({ email: 1 }, { sparse: true });

export default mongoose.models.Partner || mongoose.model("Partner", partnerSchema);

