import express from "express";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { auth, requireRole } from "../middleware/auth.js";
import { uploadBuffer } from "../lib/s3.js";
import { Image } from "../models/Image.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Local storage fallback
const LOCAL_UPLOAD_DIR = path.resolve(__dirname, "../../public/uploads");

router.post("/image", auth, requireRole(["admin", "store"]), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_file" });

  try {
    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const existing = await Image.findOne({ hash });
    if (existing) {
      return res.json({ url: existing.url, key: existing.publicId });
    }

    let result;

    // Try S3 first if configured
    if (process.env.AWS_S3_BUCKET_NAME) {
      try {
        result = await uploadBuffer(req.file.buffer, "products", {
          mimetype: req.file.mimetype,
          originalName: req.file.originalname
        });
      } catch (s3Err) {
        console.warn("S3 upload failed, falling back to local upload", s3Err);
        result = null;
      }
    }

    // Fallback to local storage if S3 fails or not configured
    if (!result) {
      // Ensure directory exists
      if (!fs.existsSync(LOCAL_UPLOAD_DIR)) {
        fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
      }

      const EXT_FROM_MIME = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif"
      };

      const ext = EXT_FROM_MIME[req.file.mimetype] || ".jpg";
      const random = crypto.randomBytes(4).toString("hex");
      const key = `uploads/${Date.now()}-${random}${ext}`;
      const localPath = path.resolve(__dirname, "../../public/", key);

      fs.writeFileSync(localPath, req.file.buffer);

      const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
      result = {
        url: `${baseUrl}/${key}`,
        key,
        contentType: req.file.mimetype
      };
    }

    await Image.create({ hash, url: result.url, publicId: result.key });

    res.json(result);
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).json({ error: "upload_failed" });
  }
});

export default router;
