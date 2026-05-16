import mongoose from "mongoose";

const subCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

subCategorySchema.index({ name: 1 });
subCategorySchema.index({ slug: 1 });
subCategorySchema.index({ category: 1 });

export default mongoose.models.SubCategory || mongoose.model("SubCategory", subCategorySchema);
