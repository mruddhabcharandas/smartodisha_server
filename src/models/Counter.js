import mongoose from "mongoose";

const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Number, required: true, default: 0 }
  },
  { timestamps: true }
);

counterSchema.index({ key: 1 }, { unique: true });

export default mongoose.models.Counter || mongoose.model("Counter", counterSchema);
