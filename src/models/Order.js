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
    orderNumber: { type: String, unique: true },
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      alternatePhone: { type: String, default: "" },
      email: { type: String, default: "" }
    },
    store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true }, // Added store reference
    items: { type: [orderItemSchema], required: true },
    totalEstimate: { type: Number, required: true },
    productTotal: { type: Number, default: 0 }, // Total after coupon, before shipping
    shippingCost: { type: Number, default: 0 },
    codCharge: { type: Number, default: 0 },
    storeRevenue: { type: Number, default: 0 }, // Store's revenue after admin cut
    adminRevenue: { type: Number, default: 0 }, // Admin's cut
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

// Pre-save hook to generate order number
orderSchema.pre('save', async function (next) {
  if (!this.orderNumber) {
    try {
      // Get the current year and month
      const now = new Date();
      const year = now.getFullYear().toString().slice(-2);
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      
      // Find the last order with the same year and month prefix
      const lastOrder = await this.constructor.findOne(
        { orderNumber: { $regex: `^CK${year}${month}` } },
        { orderNumber: 1 },
        { sort: { orderNumber: -1 } }
      );
      
      let sequence = 1;
      if (lastOrder) {
        const lastSequence = parseInt(lastOrder.orderNumber.slice(-6), 10);
        sequence = lastSequence + 1;
      }
      
      this.orderNumber = `CK${year}${month}${sequence.toString().padStart(6, '0')}`;
    } catch (error) {
      console.error('Error generating order number:', error);
      // Fallback to timestamp-based order number
      this.orderNumber = `CK${Date.now().toString().slice(-8)}`;
    }
  }
  next();
});

orderSchema.index({ status: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ orderNumber: 1 });

export default mongoose.models.Order || mongoose.model("Order", orderSchema);
