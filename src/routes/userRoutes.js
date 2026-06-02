import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Customer from "../models/Customer.js";

const router = express.Router();

router.get("/me", auth, async (req, res) => {
  if (req.user.role === "admin") {
    const Admin = (await import("../models/Admin.js")).default;
    const admin = await Admin.findById(req.user.id).select("name email");
    if (!admin) return res.status(404).json({ error: "not_found" });
    return res.json({
      id: admin._id.toString(),
      name: admin.name,
      email: admin.email,
      role: "admin"
    });
  }

  const user = await Customer.findById(req.user.id).select("name email phone address isKycComplete kyc");
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({
    id: user._id.toString(),
    name: user.name,
    email: user.email || "",
    phone: user.phone,
    address: user.address || "",
    isKycComplete: !!user.isKycComplete,
    kyc: user.kyc || {},
    role: "customer"
  });
});

router.put("/profile", auth, requireRole("customer"), async (req, res) => {
  const payload = req.body || {};
  const user = await Customer.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "not_found" });

  if (typeof payload.name === "string" && payload.name.trim()) {
    user.name = payload.name.trim();
  }
  if (typeof payload.address === "string") {
    user.address = payload.address.trim();
  }
  
  await user.save();

  res.json({
    name: user.name,
    address: user.address
  });
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
