import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, lowercase: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", default: null },
    attributes: { type: [String], default: [] },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export default mongoose.models.Category || mongoose.model("Category", categorySchema);
