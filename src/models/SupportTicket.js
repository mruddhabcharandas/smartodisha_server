import mongoose from 'mongoose';

const ticketMessageSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'senderModel',
    required: false
  },
  senderModel: {
    type: String,
    required: true,
    enum: ['Customer', 'Admin', 'System'],
    default: 'Customer'
  },
  message: {
    type: String,
    required: true
  },
  messageType: {
    type: String,
    enum: ['TEXT', 'MEDIA_REQUEST', 'MEDIA_RESPONSE', 'SYSTEM'],
    default: 'TEXT'
  },
  mediaRequest: {
    prompt: { type: String, default: '' },
    mediaType: { type: String, enum: ['IMAGE', 'VIDEO', 'IMAGE_OR_VIDEO'], default: 'IMAGE_OR_VIDEO' },
    status: { type: String, enum: ['PENDING', 'FULFILLED', 'EXPIRED'], default: 'PENDING' },
    fulfilledUrl: { type: String, default: '' },
    fulfilledMediaType: { type: String, default: '' },
    fulfilledAt: { type: Date }
  },
  attachments: [{
    type: String
  }],
  readAt: {
    type: Date
  }
}, {
  timestamps: true
});

const supportTicketSchema = new mongoose.Schema({
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  },
  subject: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  category: {
    type: String,
    enum: ['Order Issue', 'Product Issue', 'Payment Issue', 'Return/Refund', 'General Query', 'Other'],
    default: 'Other'
  },
  priority: {
    type: String,
    enum: ['Low', 'Medium', 'High', 'Urgent'],
    default: 'Medium'
  },
  status: {
    type: String,
    enum: ['Open', 'In Progress', 'Resolved', 'Closed'],
    default: 'Open'
  },
  messages: [ticketMessageSchema],
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  resolvedAt: {
    type: Date
  },
  closedAt: {
    type: Date
  }
}, {
  timestamps: true
});

export default mongoose.model('SupportTicket', supportTicketSchema);
