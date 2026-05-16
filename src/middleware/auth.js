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

