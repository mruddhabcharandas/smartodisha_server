import mongoose from "mongoose";
import bcrypt from "bcrypt";

const imageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  publicId: { type: String }
});

const storeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    phone: { type: String, required: true, trim: true },
    address: {
      line1: { type: String, default: "" },
      line2: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, default: "" }
    },
    gstNumber: { type: String, default: "" },
    image: { type: imageSchema, default: null },
    storePercentage: { type: Number, default: 0, min: 0 }, // Store's markup percentage
    adminCutPercentage: { type: Number, default: 5, min: 0 }, // Admin's percentage cut
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: true },
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date }
  },
  { timestamps: true }
);

// Hash password before saving
storeSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// Method to compare passwords
storeSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

storeSchema.index({ name: 1 }, { unique: true });
storeSchema.index({ email: 1 }, { unique: true });

export default mongoose.models.Store || mongoose.model("Store", storeSchema);
