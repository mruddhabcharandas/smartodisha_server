import mongoose from "mongoose";

const storeRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },
    businessName: { type: String, required: true, trim: true },
    address: {
      line1: { type: String, default: "" },
      line2: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, default: "" }
    },
    message: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending"
    },
    notes: { type: String, default: "" }
  },
  { timestamps: true }
);

export default mongoose.models.StoreRequest || mongoose.model("StoreRequest", storeRequestSchema);
