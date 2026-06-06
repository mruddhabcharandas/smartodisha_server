import express from "express";
import multer from "multer";
import crypto from "crypto";
import { auth, requireRole } from "../middleware/auth.js";
import { uploadBuffer } from "../lib/s3.js";
import { Image } from "../models/Image.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/image", auth, requireRole(["admin", "store"]), upload.single("file"), async (req, res) => {
  if (!process.env.AWS_S3_BUCKET_NAME) return res.status(503).json({ error: "s3_not_configured" });
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  try {
    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const existing = await Image.findOne({ hash });
    if (existing) {
      return res.json({ url: existing.url, key: existing.publicId });
    }

    const result = await uploadBuffer(req.file.buffer, "products", {
      mimetype: req.file.mimetype,
      originalName: req.file.originalname
    });
    
    await Image.create({ hash, url: result.url, publicId: result.key });

    res.json(result);
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).json({ error: "upload_failed" });
  }
});

export default router;
