import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

const s3Client = new S3Client({
  region: "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

export const uploadBuffer = async (buffer, folder = "products") => {
  if (!process.env.AWS_S3_BUCKET_NAME) throw new Error("s3_not_configured");
  
  const key = `${folder}/${crypto.randomUUID()}`;
  
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: key,
    Body: buffer
  });

  await s3Client.send(command);
  
  const url = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.ap-south-1.amazonaws.com/${key}`;
  return { url, key };
};

export const getPresignedUrl = async (key, expiresIn = 3600) => {
  if (!process.env.AWS_S3_BUCKET_NAME) throw new Error("s3_not_configured");
  
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: key
  });
  
  return await getSignedUrl(s3Client, command, { expiresIn });
};
