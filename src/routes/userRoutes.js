import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Customer from "../models/Customer.js";

const router = express.Router();

router.get("/me", auth, async (req, res) => {
  if (req.user.role === "admin") {
    const Admin = (await import("../models/Admin.js")).default;
    const admin = await Admin.findById(req.user.id).select("name email");
    if (!admin) return res.status(404).json({ error: "not found" });
    return res.json({
      id: admin._id.toString(),
      name: admin.name,
      email: admin.email,
      role: "admin"
    });
  }

  const user = await Customer.findById(req.user.id).select("name email phone address avatar isKycComplete kyc savedAddresses");
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({
    id: user._id.toString(),
    name: user.name,
    email: user.email || "",
    phone: user.phone,
    address: user.address || "",
    avatar: user.avatar || "",
    isKycComplete: !!user.isKycComplete,
    kyc: user.kyc || {},
    savedAddresses: user.savedAddresses || [],
    role: "customer"
  });
});

router.put("/profile", auth, requireRole("customer"), async (req, res) => {
  const payload = req.body || {};
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not found" });

  if (typeof payload.name === "string" && payload.name.trim()) {
    user.name = payload.name.trim();
  }
  if (typeof payload.avatar === "string") {
    user.avatar = payload.avatar.trim();
  }
  
  await user.save();

  res.json({
    name: user.name,
    avatar: user.avatar
  });
});

// Saved Addresses endpoints
router.get("/addresses", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id).select("savedAddresses");
  if (!user) return res.status(404).json({ error: "not found" });
  res.json(user.savedAddresses || []);
});

router.post("/addresses", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not found" });
  
  const address = req.body;
  const isFirstAddress = user.savedAddresses.length === 0;
  if (isFirstAddress) {
    address.isDefault = true;
  } else if (address.isDefault) {
    // Unset other default addresses
    user.savedAddresses.forEach(addr => addr.isDefault = false);
  }
  
  user.savedAddresses.push(address);
  await user.save();
  res.json(user.savedAddresses[user.savedAddresses.length - 1]);
});

router.put("/addresses/:id", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not found" });
  
  const addressId = req.params.id;
  const address = user.savedAddresses.id(addressId);
  
  if (!address) return res.status(404).json({ error: "address not found" });
  
  const updates = req.body;
  
  if (updates.isDefault) {
    user.savedAddresses.forEach(addr => addr.isDefault = false);
  }
  
  Object.assign(address, updates);
  await user.save();
  res.json(address);
});

router.delete("/addresses/:id", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not found" });
  
  const addressId = req.params.id;
  user.savedAddresses.pull(addressId);
  
  await user.save();
  res.json({ message: "address deleted" });
});

router.post("/addresses/:id/set-default", auth, requireRole("customer"), async (req, res) => {
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not found" });
  
  const addressId = req.params.id;
  
  user.savedAddresses.forEach(addr => {
    addr.isDefault = addr._id.toString() === addressId;
  });
  
  await user.save();
  res.json(user.savedAddresses);
});

router.put("/kyc", auth, requireRole("customer"), async (req, res) => {
  const payload = req.body || {};
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });

  const allowed = ["fullName", "addressLine1", "addressLine2", "city", "district", "state", "pincode"];
  
  const kyc = { ...(user.kyc || {}) };
  
  for (const k of allowed) {
    if (typeof payload[k] === "string") {
      const value = payload[k].trim();
      kyc[k] = value;
    }
  }

  const requiredFilled = (kyc.fullName && kyc.addressLine1 && kyc.city && kyc.district && kyc.state && kyc.pincode);
  
  user.kyc = kyc;
  user.isKycComplete = !!requiredFilled;
  
  if (requiredFilled) {
    user.address = `${kyc.addressLine1}${kyc.addressLine2 ? `, ${kyc.addressLine2}` : ''}, ${kyc.city}, ${kyc.district}, ${kyc.state} - ${kyc.pincode}`;
  }
  
  await user.save();

  res.json({ isKycComplete: user.isKycComplete, kyc: user.kyc, address: user.address });
});

export default router;
