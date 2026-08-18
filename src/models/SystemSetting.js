import mongoose from "mongoose";

const systemSettingSchema = new mongoose.Schema(
  {
    freeDeliveryAbove: { type: Number, default: 999 }
  },
  { timestamps: true }
);

export default mongoose.models.SystemSetting || mongoose.model("SystemSetting", systemSettingSchema);
