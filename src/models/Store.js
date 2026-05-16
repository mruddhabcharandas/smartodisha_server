import mongoose from "mongoose";

const storeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    sections: { type: [String], default: [] },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

storeSchema.index({ name: 1 }, { unique: true });

export default mongoose.models.Store || mongoose.model("Store", storeSchema);
