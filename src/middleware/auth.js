import jwt from "jsonwebtoken";

export const auth = (req, res, next) => {
  let token = "";
  const header = req.headers.authorization || "";
  const [type, authToken] = header.split(" ");
  if (type === "Bearer" && authToken) {
    token = authToken;
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
};

export const requireRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(403).json({ error: "forbidden" });
  
  const userRole = req.user.role;
  if (userRole === "admin") return next();

  if (Array.isArray(role)) {
    if (role.includes(userRole)) return next();
  } else if (userRole === role) {
    return next();
  }
  
  return res.status(403).json({ error: "forbidden" });
};

export const requirePermission = (permission) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  
  // Admin bypass
  if (req.user.role === "admin") return next();
  
  // Staff check
  if (req.user.role === "staff") {
    const perms = req.user.permissions || [];
    const required = Array.isArray(permission) ? permission : [permission];
    if (required.some(p => perms.includes(p))) return next();
    return res.status(403).json({ error: "permission_denied" });
  }
  
  return res.status(403).json({ error: "forbidden" });
};

export const verifyAdminDeletePassword = async (req, res, next) => {
  try {
    const password = req.headers["x-action-password"] || req.headers["x-password"] || req.body?.password || req.body?.currentPassword || req.query?.password;
    if (!password) {
      return res.status(400).json({ error: "Admin password is required to authorize deletion" });
    }
    const Admin = (await import("../models/Admin.js")).default;
    const adminId = req.user?.id || req.user?._id;
    if (!adminId) {
      return res.status(401).json({ error: "Unauthorized admin session" });
    }
    const admin = await Admin.findById(adminId);
    if (!admin) {
      return res.status(404).json({ error: "Admin account not found" });
    }
    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: "Incorrect admin password. Deletion cancelled." });
    }
    next();
  } catch (err) {
    console.error("Admin delete password verification failed:", err);
    return res.status(500).json({ error: "Admin password verification failed" });
  }
};

