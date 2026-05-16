import express from "express";
import multer from "multer";
import crypto from "crypto";
import { auth, requireRole } from "../middleware/auth.js";
import { configureCloudinary, uploadBuffer } from "../lib/cloudinary.js";
import { Image } from "../models/Image.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/image", auth, requireRole("admin"), upload.single("file"), async (req, res) => {
  if (!configureCloudinary()) return res.status(503).json({ error: "cloudinary_not_configured" });
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  try {
    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const existing = await Image.findOne({ hash });
    if (existing) {
      return res.json({ url: existing.url, publicId: existing.publicId });
    }

    const result = await uploadBuffer(req.file.buffer, "products");
    
    await Image.create({ hash, url: result.url, publicId: result.publicId });

    res.json(result);
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).json({ error: "upload_failed" });
  }
});

export default router;

