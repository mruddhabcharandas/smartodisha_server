import express from 'express';
import SupportTicket from '../models/SupportTicket.js';
import Order from '../models/Order.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// User Routes
// Create a new ticket
router.post('/', auth, async (req, res) => {
  try {
    const { subject, description, category, orderId } = req.body;

    const ticket = new SupportTicket({
      customer: req.user._id,
      subject,
      description,
      category,
      order: orderId || undefined
    });

    // Add initial message from user
    ticket.messages.push({
      sender: req.user._id,
      senderModel: 'Customer',
      message: description
    });

    await ticket.save();
    res.status(201).json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// Get user's tickets
router.get('/my-tickets', auth, async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ customer: req.user._id })
      .populate('order', 'orderNumber totalAmount status')
      .sort({ createdAt: -1 });
    res.json(tickets);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Get single ticket by ID (user)
router.get('/:ticketId', auth, async (req, res) => {
  try {
    const ticket = await SupportTicket.findOne({
      _id: req.params.ticketId,
      customer: req.user._id
    }).populate('order', 'orderNumber totalAmount status items');

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// Add message to ticket (user)
router.post('/:ticketId/messages', auth, async (req, res) => {
  try {
    const { message } = req.body;
    const ticket = await SupportTicket.findOne({
      _id: req.params.ticketId,
      customer: req.user._id
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.messages.push({
      sender: req.user._id,
      senderModel: 'Customer',
      message
    });

    // If ticket was resolved, re-open it
    if (ticket.status === 'Resolved') {
      ticket.status = 'Open';
      ticket.resolvedAt = undefined;
    }

    await ticket.save();
    res.json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Mark ticket as resolved (user)
router.put('/:ticketId/resolve', auth, async (req, res) => {
  try {
    const ticket = await SupportTicket.findOne({
      _id: req.params.ticketId,
      customer: req.user._id
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.status = 'Resolved';
    ticket.resolvedAt = new Date();

    // Delete messages except basic ticket info
    // We'll keep the ticket but clear the messages as requested
    ticket.messages = [];

    await ticket.save();
    res.json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve ticket' });
  }
});

// Admin Routes
// Get all tickets
router.get('/admin/all', auth, requireRole('admin'), async (req, res) => {
  try {
    const { status, category } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (category) filter.category = category;

    const tickets = await SupportTicket.find(filter)
      .populate('customer', 'name email phone')
      .populate('order', 'orderNumber totalAmount')
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 });

    res.json(tickets);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Update ticket status (admin)
router.put('/admin/:ticketId/status', auth, requireRole('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    const ticket = await SupportTicket.findById(req.params.ticketId);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.status = status;

    if (status === 'Resolved') {
      ticket.resolvedAt = new Date();
      // Clear messages when resolved as requested
      ticket.messages = [];
    }

    if (status === 'Closed') {
      ticket.closedAt = new Date();
    }

    await ticket.save();
    res.json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// Add admin message to ticket
router.post('/admin/:ticketId/messages', auth, requireRole('admin'), async (req, res) => {
  try {
    const { message } = req.body;
    const ticket = await SupportTicket.findById(req.params.ticketId);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    ticket.messages.push({
      sender: req.admin._id,
      senderModel: 'Admin',
      message
    });

    if (ticket.status === 'Open') {
      ticket.status = 'In Progress';
    }

    await ticket.save();
    res.json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
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

    ticket.assignedTo = adminId;
    await ticket.save();
    res.json(ticket);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign ticket' });
  }
});

export default router;
