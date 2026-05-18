import express from "express";
import { auth, requireRole } from "../middleware/auth.js";
import Wishlist from "../models/Wishlist.js";
import Product from "../models/Product.js";

const router = express.Router();

router.get("/", auth, requireRole("customer"), async (req, res) => {
  try {
    const wishlist = await Wishlist.findOne({ customer: req.user.id }).populate("items.product");
    res.json(wishlist || { items: [] });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
});

router.post("/add", auth, requireRole("customer"), async (req, res) => {
  try {
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({ error: "Product ID is required" });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    let wishlist = await Wishlist.findOne({ customer: req.user.id });

    if (!wishlist) {
      wishlist = new Wishlist({ customer: req.user.id, items: [] });
    }

    const existingItem = wishlist.items.find(item => item.product.toString() === productId);
    if (existingItem) {
      return res.json({ message: "Product already in wishlist", wishlist });
    }

    wishlist.items.push({ product: productId });
    await wishlist.save();
    await wishlist.populate("items.product");

    res.json({ message: "Product added to wishlist", wishlist });
  } catch (error) {
    res.status(500).json({ error: "Failed to add to wishlist" });
  }
});

router.delete("/remove/:productId", auth, requireRole("customer"), async (req, res) => {
  try {
    const { productId } = req.params;

    let wishlist = await Wishlist.findOne({ customer: req.user.id });
    if (!wishlist) {
      return res.status(404).json({ error: "Wishlist not found" });
    }

    wishlist.items = wishlist.items.filter(item => item.product.toString() !== productId);
    await wishlist.save();
    await wishlist.populate("items.product");

    res.json({ message: "Product removed from wishlist", wishlist });
  } catch (error) {
    res.status(500).json({ error: "Failed to remove from wishlist" });
  }
});

export default router;
