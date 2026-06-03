import mongoose from "mongoose";
import bcrypt from "bcrypt";

const addressSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  phone: { type: String, required: true },
  addressLine1: { type: String, required: true },
  addressLine2: { type: String, default: "" },
  city: { type: String, required: true },
  district: { type: String, default: "" },
  state: { type: String, required: true },
  pincode: { type: String, required: true },
  isDefault: { type: Boolean, default: false }
});

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, unique: true },
    email: { type: String, unique: true, lowercase: true, trim: true, sparse: true },
    password: { type: String, minlength: 6 },
    address: { type: String, default: "" }, // For backward compatibility
    avatar: { type: String, default: "" },
    savedAddresses: [addressSchema],
    purchaseHistory: [{ type: mongoose.Schema.Types.ObjectId, ref: "Bill" }],
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    kyc: {
      fullName: { type: String, default: "" },
      addressLine1: { type: String, default: "" },
      addressLine2: { type: String, default: "" },
      city: { type: String, default: "" },
      district: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, default: "" }
    },
    isKycComplete: { type: Boolean, default: false }
  },
  { timestamps: true }
);

customerSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

customerSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

export default mongoose.models.Customer || mongoose.model("Customer", customerSchema);
