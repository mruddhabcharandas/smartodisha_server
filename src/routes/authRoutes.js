import express from "express";
import jwt from "jsonwebtoken";
import Admin from "../models/Admin.js";
import Customer from "../models/Customer.js";
import OTP from "../models/OTP.js";
import { sendOTP, sendEmail } from "../lib/mailer.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = express.Router();

const validateEmailFormat = (email) => {
  return String(email)
    .toLowerCase()
    .match(
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    );
};

const validatePhoneNumber = (phone) => {
  const digitsOnly = String(phone).replace(/\D/g, "");
  return digitsOnly.length === 10;
};

// ADMIN LOGIN
router.post("/login", rateLimit("admin-login", 5, 900), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "missing_fields" });
  if (!validateEmailFormat(email)) return res.status(400).json({ error: "invalid_email_format" });
  
  const admin = await Admin.findOne({ email: email.toLowerCase().trim(), isActive: true });
  if (!admin) return res.status(401).json({ error: "invalid_credentials" });
  
  const ok = await admin.comparePassword(password);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });
  
  admin.lastLogin = new Date();
  await admin.save();
  
  const token = jwt.sign(
    { 
      id: admin._id.toString(), 
      role: admin.role || "admin", 
      email: admin.email,
      permissions: admin.permissions || []
    },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );
  res.json({
    token,
    admin: { 
      id: admin._id.toString(), 
      name: admin.name, 
      email: admin.email, 
      role: admin.role || "admin",
      permissions: admin.permissions || []
    }
  });
});

// CUSTOMER SIGNUP - Step 1: Send OTP
router.post("/customer/signup", rateLimit("customer-signup", 3, 600), async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !phone || !password) return res.status(400).json({ error: "missing_fields" });
  if (!validateEmailFormat(email)) return res.status(400).json({ error: "invalid_email_format" });
  
  // Clean and validate phone number
  const cleanedPhone = String(phone).replace(/\D/g, "");
  if (!validatePhoneNumber(cleanedPhone)) return res.status(400).json({ error: "invalid_phone" });

  const exists = await Customer.findOne({ $or: [{ email: email.toLowerCase() }, { phone: cleanedPhone }] });
  if (exists) return res.status(400).json({ error: "user_already_exists" });

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

  await OTP.findOneAndUpdate(
    { email: email.toLowerCase(), purpose: "SIGNUP" },
    { otp, expiresAt, metadata: { name, phone: cleanedPhone, password } },
    { upsert: true }
  );

  try {
    await sendOTP(email, otp, "ACCOUNT_VERIFICATION");
    res.json({ message: "otp_sent" });
  } catch (err) {
    res.status(500).json({ error: "failed_to_send_email" });
  }
});

// CUSTOMER SIGNUP - Step 2: Verify OTP
router.post("/customer/verify-otp", async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) return res.status(400).json({ error: "missing_fields" });

  const record = await OTP.findOne({ email: email.toLowerCase(), otp, purpose: "SIGNUP" });
  if (!record) return res.status(400).json({ error: "invalid_otp" });

  const { name, phone, password } = record.metadata;
  const customer = await Customer.create({
    name,
    email: email.toLowerCase(),
    phone,
    password,
    isVerified: true,
    isActive: true
  });

  await OTP.deleteOne({ _id: record._id });

  const token = jwt.sign(
    { id: customer._id.toString(), role: "customer", email: customer.email },
    process.env.JWT_SECRET,
    { expiresIn: "60m" }
  );

  res.json({
    token,
    user: { id: customer._id.toString(), name: customer.name, email: customer.email, role: "customer", isKycComplete: !!customer.isKycComplete }
  });
});

// CUSTOMER LOGIN
router.post("/customer/login", rateLimit("customer-login", 10, 600), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "missing_fields" });
  if (!validateEmailFormat(email)) return res.status(400).json({ error: "invalid_email_format" });

  const user = await Customer.findOne({ email: email.toLowerCase().trim() });
  if (!user) return res.status(404).json({ error: "user_not_found" });
  if (!user.isActive) return res.status(403).json({ error: "account_pending_approval" });

  const ok = await user.comparePassword(password);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  const token = jwt.sign(
    { id: user._id.toString(), role: "customer", email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "60m" }
  );

  res.json({
    token,
    user: { id: user._id.toString(), name: user.name, email: user.email, role: "customer", isKycComplete: !!user.isKycComplete }
  });
});

// FORGOT PASSWORD - Step 1: Send OTP
router.post("/customer/forgot-password", rateLimit("customer-forgot-password", 3, 600), async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "missing_email" });
  if (!validateEmailFormat(email)) return res.status(400).json({ error: "invalid_email_format" });

  const user = await Customer.findOne({ email: email.toLowerCase(), isActive: true });
  if (!user) return res.status(404).json({ error: "user_not_found" });

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await OTP.findOneAndUpdate(
    { email: email.toLowerCase(), purpose: "FORGOT_PASSWORD" },
    { otp, expiresAt },
    { upsert: true }
  );

  try {
    await sendOTP(email, otp, "FORGOT_PASSWORD");
    res.json({ message: "otp_sent" });
  } catch (err) {
    res.status(500).json({ error: "failed_to_send_email" });
  }
});

// FORGOT PASSWORD - Step 2: Reset
router.post("/customer/reset-password", rateLimit("customer-reset-password", 5, 600), async (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  if (!email || !otp || !newPassword) return res.status(400).json({ error: "missing_fields" });

  const record = await OTP.findOne({ email: email.toLowerCase(), otp, purpose: "FORGOT_PASSWORD" });
  if (!record) return res.status(400).json({ error: "invalid_otp" });

  const user = await Customer.findOne({ email: email.toLowerCase() });
  if (!user) return res.status(404).json({ error: "user_not_found" });

  user.password = newPassword;
  await user.save();

  await OTP.deleteOne({ _id: record._id });

  res.json({ message: "password_reset_success" });
});

// CUSTOMER LOGIN VIA OTP - Step 1: Send OTP
router.post("/customer/login-otp/send", rateLimit("customer-otp-login", 3, 600), async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "missing_email" });
  if (!validateEmailFormat(email)) return res.status(400).json({ error: "invalid_email_format" });
  const user = await Customer.findOne({ email: String(email).toLowerCase().trim() });
  if (!user) return res.status(404).json({ error: "user_not_found" });
  if (!user.isActive) return res.status(403).json({ error: "account_pending_approval" });
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await OTP.findOneAndUpdate(
    { email: user.email, purpose: "LOGIN" },
    { otp, expiresAt },
    { upsert: true }
  );
  try {
    await sendOTP(user.email, otp, "LOGIN");
    res.json({ message: "otp_sent" });
  } catch {
    res.status(500).json({ error: "failed_to_send_email" });
  }
});

// CUSTOMER LOGIN VIA OTP - Step 2: Verify
router.post("/customer/login-otp/verify", rateLimit("customer-otp-verify", 5, 600), async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) return res.status(400).json({ error: "missing_fields" });
  const record = await OTP.findOne({ email: String(email).toLowerCase().trim(), otp, purpose: "LOGIN" });
  if (!record) return res.status(400).json({ error: "invalid_otp" });
  const user = await Customer.findOne({ email: String(email).toLowerCase().trim() });
  if (!user) return res.status(404).json({ error: "user_not_found" });
  if (!user.isActive) return res.status(403).json({ error: "account_pending_approval" });
  await OTP.deleteOne({ _id: record._id });
  const token = jwt.sign(
    { id: user._id.toString(), role: "customer", email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "60m" }
  );
  res.json({
    token,
    user: { id: user._id.toString(), name: user.name, email: user.email, role: "customer", isKycComplete: !!user.isKycComplete }
  });
});

// GOOGLE OAUTH LOGIN/SIGNUP
router.post("/customer/google", async (req, res) => {
  try {
    const { email, name } = req.body || {};
    if (!email) return res.status(400).json({ error: "missing_email" });

    // Check if customer exists with this email
    let customer = await Customer.findOne({ email: email.toLowerCase().trim() });

    if (!customer) {
      // Need phone number to create new customer
      return res.status(400).json({ error: "phone_required", email, name });
    }

    // Existing customer, log them in
    if (!customer.isActive) return res.status(403).json({ error: "account_pending_approval" });

    const token = jwt.sign(
      { id: customer._id.toString(), role: "customer", email: customer.email },
      process.env.JWT_SECRET,
      { expiresIn: "60m" }
    );

    res.json({
      token,
      user: { id: customer._id.toString(), name: customer.name, email: customer.email, role: "customer", isKycComplete: !!customer.isKycComplete }
    });
  } catch (err) {
    console.error("Google OAuth error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// GOOGLE OAUTH SIGNUP (with phone)
router.post("/customer/google/signup", async (req, res) => {
  try {
    const { email, name, phone } = req.body || {};
    if (!email || !phone || !name) return res.status(400).json({ error: "missing_fields" });
    
    // Clean and validate phone number
    const cleanedPhone = String(phone).replace(/\D/g, "");
    if (!validatePhoneNumber(cleanedPhone)) return res.status(400).json({ error: "invalid_phone" });

    // Check if customer already exists
    const existingCustomer = await Customer.findOne({ 
      $or: [{ email: email.toLowerCase().trim() }, { phone: cleanedPhone }] 
    });
    if (existingCustomer) {
      if (existingCustomer.email === email.toLowerCase().trim()) {
        // Log them in
        if (!existingCustomer.isActive) return res.status(403).json({ error: "account_pending_approval" });
        const token = jwt.sign(
          { id: existingCustomer._id.toString(), role: "customer", email: existingCustomer.email },
          process.env.JWT_SECRET,
          { expiresIn: "60m" }
        );
        return res.json({
          token,
          user: { id: existingCustomer._id.toString(), name: existingCustomer.name, email: existingCustomer.email, role: "customer", isKycComplete: !!existingCustomer.isKycComplete }
        });
      } else {
        return res.status(400).json({ error: "phone_already_used" });
      }
    }

    // Create new customer
    const customer = await Customer.create({
      name,
      email: email.toLowerCase().trim(),
      phone: cleanedPhone,
      isVerified: true,
      isActive: true
    });

    const token = jwt.sign(
      { id: customer._id.toString(), role: "customer", email: customer.email },
      process.env.JWT_SECRET,
      { expiresIn: "60m" }
    );

    res.json({
      token,
      user: { id: customer._id.toString(), name: customer.name, email: customer.email, role: "customer", isKycComplete: !!customer.isKycComplete }
    });
  } catch (err) {
    console.error("Google OAuth signup error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

export default router;
