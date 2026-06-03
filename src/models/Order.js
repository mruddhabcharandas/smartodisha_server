import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    gst: { type: Number, required: true },
    quantity: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    variantSku: { type: String, default: "" },
    attributes: { type: Map, of: String },
    image: { type: String, default: "" }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      alternatePhone: { type: String, default: "" },
      email: { type: String, default: "" }
    },
    items: { type: [orderItemSchema], required: true },
    totalEstimate: { type: Number, required: true },
    couponCode: { type: String, default: "" },
    couponDiscount: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: ["CASHFREE", "MANUAL", "COD"], default: "CASHFREE" },
    paymentStatus: { type: String, enum: ["PENDING", "PAID", "FAILED", "REFUNDED"], default: "PENDING" },
    cashfreeOrderId: { type: String },
    cashfreePaymentId: { type: String },
    cashfreeSignature: { type: String },
    codDueAmount: { type: Number, default: 0 },
    status: { 
      type: String, 
      enum: ["PENDING", "PENDING_PAYMENT", "CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RETURNED"], 
      default: "PENDING" 
    },
    notes: { type: String, default: "" },
    feedbackRating: { type: Number, min: 1, max: 5 },
    shipping: {
      provider: { type: String, default: "SHIPROCKET" },
      waybill: { type: String },
      status: { type: String },
      trackingUrl: { type: String }
    },
    shippingAddress: {
      line1: { type: String, required: true },
      line2: { type: String, default: "" },
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true }
    },
    shiprocketOrderId: { type: String, default: "" },
    shiprocketShipmentId: { type: String, default: "" },
    shiprocketAwbNumber: { type: String, default: "" },
    refundAmount: { type: Number, default: 0 },
    refundReason: { type: String, default: "" },
    refundId: { type: String, default: "" },
    refundStatus: { type: String, enum: ["NONE", "PENDING", "SUCCESS", "FAILED"], default: "NONE" }
  },
  { timestamps: true }
);

orderSchema.index({ status: 1 });
orderSchema.index({ createdAt: -1 });

export default mongoose.models.Order || mongoose.model("Order", orderSchema);
