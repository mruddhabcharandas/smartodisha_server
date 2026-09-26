import mongoose from "mongoose";

const systemSettingSchema = new mongoose.Schema(
  {
    freeDeliveryAbove: { type: Number, default: 999 },
    supportWebhookUrl: { type: String, default: "" }
  },
  { timestamps: true }
);

export default mongoose.models.SystemSetting || mongoose.model("SystemSetting", systemSettingSchema);
