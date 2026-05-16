import mongoose from "mongoose";

const itemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    category: { type: String, default: "General" },
    price: { type: Number, required: true },
    gst: { type: Number, required: true },
    quantity: { type: Number, required: true },
    lineSubtotal: { type: Number, required: true },
    lineGst: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    hsn: { type: String, default: "" },
    image: { type: String, default: "" }
  },
  { _id: false }
);

const gstBreakdownSchema = new mongoose.Schema(
  {
    rate: { type: Number, required: true },
    amount: { type: Number, required: true }
  },
  { _id: false }
);

const billSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    items: { type: [itemSchema], required: true },
    subtotal: { type: Number, required: true },
    gstTotal: { type: Number, required: true },
    total: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    payable: { type: Number, required: true },
    couponCode: { type: String },
    gstBreakdown: { type: [gstBreakdownSchema], default: [] },
    paymentType: { type: String, enum: ["CASH", "CARD", "UPI", "ONLINE"], default: "CASH" },
    date: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

billSchema.index({ invoiceNumber: 1 }, { unique: true });

export default mongoose.models.Bill || mongoose.model("Bill", billSchema);
