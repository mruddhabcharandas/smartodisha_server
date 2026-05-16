import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  hash: { type: String, required: true, unique: true, index: true },
  url: { type: String, required: true },
  publicId: { type: String }
}, { timestamps: true });

export const Image = mongoose.models.Image || mongoose.model('Image', schema);
