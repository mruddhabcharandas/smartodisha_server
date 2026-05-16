import mongoose from "mongoose";

export const connectIfConfigured = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) return;
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB || undefined });
};

