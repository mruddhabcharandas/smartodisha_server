import mongoose from "mongoose";

const imageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  publicId: { type: String }
});

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, trim: true, unique: true, sparse: true },
    description: { type: String, default: "" },
    price: { type: Number, required: true, min: 0 },
    originalStorePrice: { type: Number, min: 0 }, // Original price set by store (before markup)
    sku: { type: String, trim: true, index: true }, // Top-level SKU for simple products
    hsnCode: { type: String, default: "" },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", default: null, index: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true, index: true },
    subCategory: { type: mongoose.Schema.Types.ObjectId, ref: "SubCategory", index: true },
    store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", default: null, index: true },
    images: { type: [imageSchema], default: [] },
    stock: { type: Number, required: true, min: 0 },
    weight: { type: Number, default: 0, min: 0 }, // weight in grams
    gst: { type: Number, default: 0, min: 0 },
    mrp: { type: Number, min: 0 },
    highlights: { type: [String], default: [] },
    specifications: {
      type: [
        {
          key: { type: String, trim: true, maxlength: 120 },
          value: { type: String, trim: true, maxlength: 500 }
        }
      ],
      default: []
    },
    attributes: { type: [String], default: [] }, // e.g. ["color", "ram", "storage"] or ["model"]
    variants: {
      type: [
        {
          _id: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
          attributes: { type: Map, of: String }, // Flexible map for dynamic attributes
          price: { type: Number, min: 0 },
          originalStorePrice: { type: Number, min: 0 }, // Original variant price from store
          mrp: { type: Number, min: 0 },
          stock: { type: Number, min: 0, default: 0 },
          sku: { type: String },
          weight: { type: Number, default: 0 }, // Weight in grams for variant
          isActive: { type: Boolean, default: true },
          images: { type: [imageSchema], default: [] }
        }
      ],
      default: []
    },
    variantDisplayType: { type: String, enum: ['selector', 'matrix'], default: 'selector' },
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: true },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    priceTrend: { type: Number, enum: [0, 1], default: 0 } // 0 = down, 1 = up
  },
  { timestamps: true }
);

// Function to generate slug from name
function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .trim()
    .substring(0, 100);
}

// Pre-save hook to auto-generate slug if not present
productSchema.pre('save', async function (next) {
  if (!this.slug && this.name) {
    let baseSlug = generateSlug(this.name);
    let slug = baseSlug;
    let counter = 1;

    // Ensure unique slug
    while (true) {
      const existing = await mongoose.models.Product?.findOne({ slug, _id: { $ne: this._id } });
      if (!existing) break;
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    this.slug = slug;
  }
  next();
});

productSchema.index({ name: 1 });
productSchema.index({ category: 1 });
productSchema.index({ sku: 1 });
productSchema.index({ name: "text", description: "text" }, { weights: { name: 10, description: 2 } });
productSchema.index({ brand: 1, category: 1, subCategory: 1 });
productSchema.index({ isActive: 1, createdAt: -1 });
productSchema.index({ isActive: 1, stock: 1 });

export default mongoose.models.Product || mongoose.model("Product", productSchema);
