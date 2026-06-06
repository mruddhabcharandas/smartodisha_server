import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import path from "path";

const s3Client = new S3Client({
  region: "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const EXT_FROM_MIME = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

const resolveExtension = (originalName, mimetype) => {
  const fromName = path.extname(String(originalName || "")).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(fromName)) {
    return fromName === ".jpeg" ? ".jpg" : fromName;
  }
  if (mimetype && EXT_FROM_MIME[mimetype]) return EXT_FROM_MIME[mimetype];
  return ".jpg";
};

export const uploadBuffer = async (buffer, folder = "products", options = {}) => {
  if (!process.env.AWS_S3_BUCKET_NAME) throw new Error("s3_not_configured");

  const { mimetype, originalName } = options;
  const ext = resolveExtension(originalName, mimetype);
  const contentType = mimetype || (ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg");
  const random = crypto.randomBytes(4).toString("hex");
  const key = `${folder}/${Date.now()}-${random}${ext}`;

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await s3Client.send(command);

  console.log(`S3 upload: key=${key} contentType=${contentType}`);

  const url = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.ap-south-1.amazonaws.com/${key}`;
  return { url, key, contentType };
};

export const getPresignedUrl = async (key, expiresIn = 3600) => {
  if (!process.env.AWS_S3_BUCKET_NAME) throw new Error("s3_not_configured");
  
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: key
  });
  
  return await getSignedUrl(s3Client, command, { expiresIn });
};
