import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    gst: { type: Number, required: true },
    quantity: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    variantSku: { type: String, default: "" }, // Phase 6 requirement
    attributes: { type: Map, of: String },
    image: { type: String, default: "" }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    type: { type: String, default: "ENQUIRY" },
    billId: { type: mongoose.Schema.Types.ObjectId, ref: "Bill" },
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String, default: "" }
    },
    items: { type: [orderItemSchema], required: true },
    totalEstimate: { type: Number, required: true },
    couponCode: { type: String, default: "" },
    couponDiscount: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: ["CASH", "RAZORPAY", "MANUAL", "COD_20"], default: "CASH" },
    paymentStatus: { type: String, enum: ["PENDING", "PAYMENT_SUBMITTED", "PARTIAL", "PAID", "FAILED", "REFUNDED"], default: "PENDING" },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    codAdvancePercent: { type: Number, default: 0 },
    advancePaidAmount: { type: Number, default: 0 },
    codDueAmount: { type: Number, default: 0 },
    status: { 
      type: String, 
      enum: ["NEW", "PENDING_PAYMENT", "PENDING_CASH_APPROVAL", "PENDING_ADMIN_APPROVAL", "CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RETURNED", "FULFILLED"], 
      default: "NEW" 
    },
    notes: { type: String, default: "" },
    manualPayment: {
      amountPaid: { type: Number, default: 0 },
      utr: { type: String, default: "" },
      note: { type: String, default: "" }
    },
    feedbackRating: { type: Number, min: 1, max: 5 },
    shipping: {
      provider: { type: String },
      waybill: { type: String },
      status: { type: String },
      trackingUrl: { type: String }
    },
    shippingAddress: {
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String }
    },
    tracking_id: { type: String, default: "" },
    awb_number: { type: String, default: "" },
    lrn: { type: String, default: "" },
    pickup_id: { type: String, default: "" },
    pickup_date: { type: String, default: "" },
    delhivery_job_id: { type: String, default: "" },
    shipment_status: { type: String, default: "" },
    shipping_charge: { type: Number, default: 0 }
    ,
    shipping_discount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

orderSchema.index({ status: 1 });
orderSchema.index({ createdAt: -1 });

export default mongoose.models.Order || mongoose.model("Order", orderSchema);
