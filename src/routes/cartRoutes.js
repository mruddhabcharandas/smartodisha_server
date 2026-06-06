import express from "express";
import mongoose from "mongoose";
import { auth, requireRole } from "../middleware/auth.js";
import Cart from "../models/Cart.js";
import Product from "../models/Product.js";

const router = express.Router();

const serializeCart = async (cart) => {
  if (!cart) return { items: [] };
  await cart.populate("items.product", "name price gst images stock variants weight minOrderQty bulkDiscountQuantity bulkDiscountPriceReduction bulkTiers mrp packSize originalStorePrice store");
  // Filter out items where product is null (deleted or inactive)
  return {
    items: cart.items.filter((it) => it.product != null).map((it) => {
      const base = {
        productId: it.product._id.toString(),
        quantity: it.quantity,
        bulkDiscountQuantity: it.product.bulkDiscountQuantity || 0,
        bulkDiscountPriceReduction: it.product.bulkDiscountPriceReduction || 0,
        bulkTiers: it.product.bulkTiers || [],
        mrp: it.product.mrp || it.product.price,
        packSize: it.product.packSize || 1,
        originalStorePrice: it.product.originalStorePrice || it.product.price || 0,
        storePercentage: it.product.store?.storePercentage || 0
      };
      if (it.variantSku) {
        const v = (it.product.variants || []).find(v => v.sku === it.variantSku);
        if (v) {
          return {
            ...base,
            variantSku: it.variantSku,
            name: it.product.name,
            attributes: v.attributes,
            price: v.price ?? it.product.price,
            originalStorePrice: v.originalStorePrice ?? v.price ?? it.product.originalStorePrice ?? it.product.price,
            gst: it.product.gst || 0,
            stock: v.stock ?? 0,
            sku: v.sku,
            image: (v.images?.[0]?.url || it.product.images?.[0]?.url || ""),
            minOrderQty: it.product.minOrderQty || 0,
            weight: v.weight || it.product.weight || 0
          };
        }
      }
      return {
        ...base,
        name: it.product.name,
        price: it.product.price,
        gst: it.product.gst || 0,
        stock: it.product.stock,
        image: it.product.images?.[0]?.url || "",
        minOrderQty: it.product.minOrderQty || 0,
        weight: it.product.weight || 0
      };
    })
  };
};

router.use(auth, requireRole("customer"));

router.get("/", async (req, res) => {
  const cart = await Cart.findOne({ customer: req.user.id });
  const payload = await serializeCart(cart);
  res.json(payload);
});

router.post("/add", async (req, res) => {
  const { productId, variantSku, quantity } = req.body || {};
  const qty = Math.round(Number(quantity || 1));

  if (!mongoose.isValidObjectId(productId) || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const product = await Product.findOne({ _id: productId, isActive: true });
  if (!product) return res.status(404).json({ error: "product_not_found" });
  let variant = null;
  if (variantSku) {
    variant = (product.variants || []).find(v => v.sku === String(variantSku));
    if (!variant || !variant.isActive) return res.status(404).json({ error: "variant_not_found" });
  }

  const minQty = Math.max(1, Math.round(Number(product.minOrderQty || 0)));
  const effQty = Math.max(qty, minQty);

  let cart = await Cart.findOne({ customer: req.user.id });
  if (!cart) {
    cart = await Cart.create({ customer: req.user.id, items: [] });
  }

  const existing = cart.items.find((it) => it.product.toString() === productId && String(it.variantSku || "") === String(variantSku || ""));
  const currentQty = existing ? existing.quantity : 0;
  const available = variant ? (variant.stock || 0) : product.stock;
  if (currentQty + effQty > available) return res.status(400).json({ error: "insufficient_stock" });

  if (existing) {
    existing.quantity += effQty;
  } else {
    cart.items.push({ product: product._id, variantSku: variantSku || undefined, quantity: effQty });
  }
  await cart.save();

  const payload = await serializeCart(cart);
  res.json(payload);
});

router.put("/update", async (req, res) => {
  const { productId, variantSku, quantity } = req.body || {};
  const qty = Math.round(Number(quantity));
  if (!mongoose.isValidObjectId(productId) || !Number.isFinite(qty)) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const cart = await Cart.findOne({ customer: req.user.id });
  if (!cart) return res.json({ items: [] });

  const idx = cart.items.findIndex((it) => it.product.toString() === productId && String(it.variantSku || "") === String(variantSku || ""));
  if (idx === -1) return res.json(await serializeCart(cart));

  if (qty <= 0) {
    cart.items.splice(idx, 1);
  } else {
    const product = await Product.findOne({ _id: productId, isActive: true });
    if (!product) return res.status(404).json({ error: "product_not_found" });
    const variant = variantSku ? (product.variants || []).find(v => v.sku === String(variantSku)) : null;
    const available = variant ? (variant.stock || 0) : product.stock;
    const minQty = Math.max(1, Number(product.minOrderQty || 0));
    const effQty = Math.max(minQty, qty);
    if (effQty > available) return res.status(400).json({ error: "insufficient_stock" });
    cart.items[idx].quantity = effQty;
  }
  await cart.save();
  res.json(await serializeCart(cart));
});

router.delete("/remove", async (req, res) => {
  const { productId, variantSku } = req.body || {};
  if (!mongoose.isValidObjectId(productId)) {
    return res.status(400).json({ error: "invalid_payload" });
  }
  const cart = await Cart.findOne({ customer: req.user.id });
  if (!cart) return res.json({ items: [] });
  cart.items = cart.items.filter((it) => !(it.product.toString() === productId && String(it.variantSku || "") === String(variantSku || "")));
  await cart.save();
  res.json(await serializeCart(cart));
});

export default router;
