import express from 'express';
import SupportTicket from '../models/SupportTicket.js';
import Order from '../models/Order.js';
import { auth, requireRole } from '../middleware/auth.js';
import { triggerSupportWebhook } from '../lib/supportWebhook.js';

const router = express.Router();

// Helper to get consistent user/admin ID
const getAuthId = (req) => req.user?.id || req.user?._id;

// ================= USER ROUTES =================

// Create a new support ticket
router.post('/', auth, async (req, res) => {
  try {
    const { subject, description, category, orderId } = req.body;
    const userId = getAuthId(req);

    if (!subject || !description) {
      return res.status(400).json({ error: 'Subject and description are required' });
    }

    const ticket = new SupportTicket({
      customer: userId,
      subject: subject.trim(),
      description: description.trim(),
      category: category || 'Other',
      order: orderId || undefined,
      status: 'Open'
    });

    // Add initial message from user
    ticket.messages.push({
      sender: userId,
      senderModel: 'Customer',
      message: description.trim(),
      messageType: 'TEXT'
    });

    // Add default automated greeting from Support Team
    ticket.messages.push({
      senderModel: 'Admin',
      message: 'Namaste! 🙏 Our support team will assist you soon. Please let us know how we can help you with your order or query.',
      messageType: 'SYSTEM'
    });

    await ticket.save();

    // Trigger external webhook
    triggerSupportWebhook('TICKET_CREATED', {
      ticketId: ticket._id,
      customer: userId,
      subject: ticket.subject,
      category: ticket.category,
      orderId: ticket.order
    });

    res.status(201).json(ticket);
  } catch (err) {
    console.error('Error creating support ticket:', err);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// Get user's own tickets
router.get('/my-tickets', auth, async (req, res) => {
  try {
    const userId = getAuthId(req);
    const tickets = await SupportTicket.find({ customer: userId })
      .populate('order', 'orderNumber totalEstimate paymentMethod status')
      .sort({ createdAt: -1 });
    res.json(tickets);
  } catch (err) {
    console.error('Error fetching my-tickets:', err);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Get single ticket by ID (user)
router.get('/:ticketId', auth, async (req, res) => {
  try {
    const userId = getAuthId(req);
    const ticket = await SupportTicket.findOne({
      _id: req.params.ticketId,
      customer: userId
    }).populate('order', 'orderNumber totalEstimate paymentMethod status items');

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json(ticket);
  } catch (err) {
    console.error('Error fetching ticket:', err);
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// Add message to ticket (user)
router.post('/:ticketId/messages', auth, async (req, res) => {
  try {
    const { message } = req.body;
    const userId = getAuthId(req);

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const ticket = await SupportTicket.findOne({
      _id: req.params.ticketId,
      customer: userId
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.messages.push({
      sender: userId,
      senderModel: 'Customer',
      message: message.trim(),
      messageType: 'TEXT'
    });

    // If ticket was resolved or closed, re-open it on user reply
    if (['Resolved', 'Closed'].includes(ticket.status)) {
      ticket.status = 'Open';
      ticket.resolvedAt = undefined;
    }

    await ticket.save();

    triggerSupportWebhook('USER_MESSAGE', {
      ticketId: ticket._id,
      customer: userId,
      message: message.trim()
    });

    res.json(ticket);
  } catch (err) {
    console.error('Error sending user message on ticket:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Fulfill a media request (user) - strictly single submission like Amazon
router.post('/:ticketId/upload-media', auth, async (req, res) => {
  try {
    const { messageId, fileUrl, mediaType } = req.body;
    const userId = getAuthId(req);

    if (!fileUrl) {
      return res.status(400).json({ error: 'File URL is required' });
    }

    const ticket = await SupportTicket.findOne({
      _id: req.params.ticketId,
      customer: userId
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const targetMsg = ticket.messages.id(messageId);
    if (!targetMsg) {
      return res.status(404).json({ error: 'Media request not found' });
    }

    if (targetMsg.messageType !== 'MEDIA_REQUEST') {
      return res.status(400).json({ error: 'Message is not a media request' });
    }

    if (targetMsg.mediaRequest?.status === 'FULFILLED') {
      return res.status(400).json({ error: 'Media has already been submitted for this request. No further uploads allowed.' });
    }

    targetMsg.mediaRequest.status = 'FULFILLED';
    targetMsg.mediaRequest.fulfilledUrl = fileUrl;
    targetMsg.mediaRequest.fulfilledMediaType = mediaType || 'IMAGE';
    targetMsg.mediaRequest.fulfilledAt = new Date();

    ticket.messages.push({
      sender: userId,
      senderModel: 'Customer',
      message: 'Uploaded verification media.',
      messageType: 'MEDIA_RESPONSE',
      attachments: [fileUrl]
    });

    if (['Resolved', 'Closed'].includes(ticket.status)) {
      ticket.status = 'In Progress';
    }

    await ticket.save();

    triggerSupportWebhook('MEDIA_UPLOADED', {
      ticketId: ticket._id,
      customer: userId,
      fileUrl,
      mediaType: mediaType || 'IMAGE'
    });

    res.json(ticket);
  } catch (err) {
    console.error('Error fulfilling media request:', err);
    res.status(500).json({ error: 'Failed to upload media' });
  }
});

// Mark ticket as resolved (user)
router.put('/:ticketId/resolve', auth, async (req, res) => {
  try {
    const userId = getAuthId(req);
    const ticket = await SupportTicket.findOne({
      _id: req.params.ticketId,
      customer: userId
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.status = 'Resolved';
    ticket.resolvedAt = new Date();

    await ticket.save();

    triggerSupportWebhook('STATUS_UPDATED', {
      ticketId: ticket._id,
      status: 'Resolved',
      resolvedBy: 'Customer'
    });

    res.json(ticket);
  } catch (err) {
    console.error('Error resolving ticket:', err);
    res.status(500).json({ error: 'Failed to resolve ticket' });
  }
});

// ================= ADMIN ROUTES =================

// Get all tickets (admin / staff)
router.get('/admin/all', auth, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const { status, category } = req.query;
    const filter = {};

    if (status && status !== 'All') filter.status = status;
    if (category && category !== 'All') filter.category = category;

    const tickets = await SupportTicket.find(filter)
      .populate('customer', 'name email phone createdAt')
      .populate({
        path: 'order',
        select: 'orderNumber totalEstimate items shippingAddress paymentMethod paymentStatus status codDueAmount delhiveryTracking createdAt'
      })
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 });

    res.json(tickets);
  } catch (err) {
    console.error('Error fetching admin tickets:', err);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Update ticket status (admin)
router.put('/admin/:ticketId/status', auth, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const { status } = req.body;
    const ticket = await SupportTicket.findById(req.params.ticketId);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.status = status;

    if (status === 'Resolved') {
      ticket.resolvedAt = new Date();
    } else if (status === 'Closed') {
      ticket.closedAt = new Date();
    }

    await ticket.save();

    triggerSupportWebhook('STATUS_UPDATED', {
      ticketId: ticket._id,
      status
    });

    res.json(ticket);
  } catch (err) {
    console.error('Error updating ticket status:', err);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// Add admin reply message to ticket
router.post('/admin/:ticketId/messages', auth, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const { message } = req.body;
    const adminId = getAuthId(req);

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const ticket = await SupportTicket.findById(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.messages.push({
      sender: adminId,
      senderModel: 'Admin',
      message: message.trim(),
      messageType: 'TEXT'
    });

    if (ticket.status === 'Open') {
      ticket.status = 'In Progress';
    }

    await ticket.save();

    triggerSupportWebhook('ADMIN_REPLY', {
      ticketId: ticket._id,
      adminId,
      message: message.trim()
    });

    // Return populated ticket
    const populated = await SupportTicket.findById(ticket._id)
      .populate('customer', 'name email phone')
      .populate('order', 'orderNumber totalEstimate paymentMethod status');

    res.json(populated);
  } catch (err) {
    console.error('Error sending admin ticket reply:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Request Photo/Video from Customer (Amazon style media verification)
router.post('/admin/:ticketId/request-media', auth, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const { prompt, mediaType } = req.body;
    const adminId = getAuthId(req);

    const ticket = await SupportTicket.findById(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.messages.push({
      sender: adminId,
      senderModel: 'Admin',
      message: prompt?.trim() || 'Support agent has requested photo or video verification for your issue.',
      messageType: 'MEDIA_REQUEST',
      mediaRequest: {
        prompt: prompt?.trim() || 'Please share a clear photo or video showing the item condition and parcel label.',
        mediaType: mediaType || 'IMAGE_OR_VIDEO',
        status: 'PENDING'
      }
    });

    if (ticket.status === 'Open') {
      ticket.status = 'In Progress';
    }

    await ticket.save();

    triggerSupportWebhook('MEDIA_REQUEST_CREATED', {
      ticketId: ticket._id,
      prompt: prompt || 'Verification requested',
      mediaType: mediaType || 'IMAGE_OR_VIDEO'
    });

    const populated = await SupportTicket.findById(ticket._id)
      .populate('customer', 'name email phone')
      .populate('order', 'orderNumber totalEstimate paymentMethod status');

    res.json(populated);
  } catch (err) {
    console.error('Error creating media request:', err);
    res.status(500).json({ error: 'Failed to request media' });
  }
});

// Assign ticket to admin
router.put('/admin/:ticketId/assign', auth, requireRole('admin'), async (req, res) => {
  try {
    const { adminId } = req.body;
    const ticket = await SupportTicket.findById(req.params.ticketId);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.assignedTo = adminId || undefined;
    await ticket.save();
    res.json(ticket);
  } catch (err) {
    console.error('Error assigning ticket:', err);
    res.status(500).json({ error: 'Failed to assign ticket' });
  }
});

export default router;
