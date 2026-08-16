import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const heroSlideSchema = new mongoose.Schema(
  {
    title: { type: String, default: "" },
    link: { type: String, default: "" },
    image: {
      url: { type: String, required: true },
      publicId: { type: String, required: true }
    },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

const HeroSlide = mongoose.models.HeroSlide || mongoose.model("HeroSlide", heroSlideSchema);

async function check() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not found in env");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("Connected to MongoDB");
  const slides = await HeroSlide.find({});
  console.log("Total slides found in DB:", slides.length);
  console.log(JSON.stringify(slides, null, 2));
  process.exit(0);
}

check().catch(console.error);
