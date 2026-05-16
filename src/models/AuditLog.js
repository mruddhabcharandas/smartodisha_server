import mongoose from "mongoose";

const auditSchema = new mongoose.Schema(
  {
    actorId: { type: String, default: "" },
    actorRole: { type: String, default: "" },
    type: { type: String, required: true }, // ORDER_STATUS|STOCK|PRODUCT_UPDATE
    entityType: { type: String, required: true }, // ORDER|PRODUCT
    entityId: { type: String, required: true },
    note: { type: String, default: "" },
    before: { type: Object, default: null },
    after: { type: Object, default: null }
  },
  { timestamps: true }
);

auditSchema.index({ type: 1, entityType: 1, createdAt: -1 });

export default mongoose.models.AuditLog || mongoose.model("AuditLog", auditSchema);
