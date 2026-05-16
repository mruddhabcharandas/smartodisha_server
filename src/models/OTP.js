import mongoose from "mongoose";

const otpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    otp: { type: String, required: true },
    purpose: { type: String, enum: ["SIGNUP", "FORGOT_PASSWORD", "LOGIN"], required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // Auto-delete after expiry
    metadata: { type: Object } // Optional: store signup data like name, phone, password
  },
  { timestamps: true }
);

export default mongoose.models.OTP || mongoose.model("OTP", otpSchema);
