import Category from "../models/Category.js";
import Brand from "../models/Brand.js";
import { getOrSetCache } from "./redis.js";

/**
 * Cache Warming - Preload frequently accessed data
 * This ensures the first user gets a lightning fast response.
 */
export const warmCache = async () => {
  console.log("🔥 Starting Cache Warming...");
  try {
    // 1. Warm Categories
    await getOrSetCache("categories:all", async () => {
      console.log("📦 Warming Categories Cache...");
      return await Category.find({ isActive: true }).sort({ name: 1 }).select({ name: 1, description: 1 });
    }, 86400);

    // 2. Warm Brands
    await getOrSetCache("brands:all:true", async () => {
      console.log("🏷️ Warming Brands Cache...");
      return await Brand.find({ isActive: true }).sort({ name: 1 });
    }, 86400);

    console.log("✅ Cache Warming Completed!");
  } catch (error) {
    console.error("❌ Cache Warming Failed:", error);
  }
};
