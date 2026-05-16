import Bill from "../models/Bill.js";
import Counter from "../models/Counter.js";

export const computeTotals = (products, items) => {
  const enriched = [];
  let subtotal = 0;
  let gstTotal = 0;
  const map = new Map();
  for (const it of items) {
    const p = products.find((x) => x._id.toString() === it.productId);
    if (!p) throw new Error("product_not_found");
    const qty = Number(it.quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error("invalid_quantity");

    const variant = it.variantSku ? (p.variants || []).find(v => v.sku === it.variantSku) : null;
    let effectivePrice = variant?.price ?? p.price;
    // Bulk pricing: prefer highest applicable tier
    if (Array.isArray(p.bulkTiers) && p.bulkTiers.length) {
      const tiers = p.bulkTiers.slice().sort((a,b) => a.quantity - b.quantity);
      const applicable = tiers.filter(t => qty >= Number(t.quantity || 0)).pop();
      if (applicable) {
        const off = Number(applicable.priceReduction || 0);
        effectivePrice = Math.max(0, (variant?.price ?? p.price) - off);
      }
    } else if (p.bulkDiscountQuantity > 0 && qty >= p.bulkDiscountQuantity) {
      effectivePrice = Math.max(0, (variant?.price ?? p.price) - (p.bulkDiscountPriceReduction || 0));
    }

    const lineTotal = effectivePrice * qty;
    const rate = p.gst || 0;
    const lineGst = rate > 0 ? Number((lineTotal - (lineTotal / (1 + rate / 100))).toFixed(2)) : 0;
    const lineSubtotal = Number((lineTotal - lineGst).toFixed(2));
    subtotal += lineSubtotal;
    gstTotal += lineGst;
    map.set(rate, (map.get(rate) || 0) + lineGst);
    
    // Convert attributes Map to plain object for Object.entries if needed
    const vAttrs = variant ? (variant.attributes instanceof Map ? Object.fromEntries(variant.attributes) : variant.attributes) : {};
    const attrText = variant ? Object.values(vAttrs || {}).filter(v => v).map(v => String(v).toUpperCase()).join(", ") : "";
    
    enriched.push({
      product: p._id,
      variantSku: variant ? variant.sku : undefined,
      name: variant ? `${p.name} (${attrText})` : p.name,
      category: p.category || "General",
      price: effectivePrice,
      gst: rate,
      quantity: qty,
      lineSubtotal,
      lineGst,
      lineTotal,
      weight: variant?.weight ?? p.weight ?? 0
    });
  }
  const gstBreakdown = [...map.entries()].map(([rate, amount]) => ({ rate, amount }));
  const total = subtotal + gstTotal;
  const totalWeight = enriched.reduce((s, it) => s + (it.weight * it.quantity), 0);
  return { items: enriched, subtotal, gstTotal, total, gstBreakdown, totalWeight };
};

export const generateInvoiceNumber = async () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const key = `invoice:${y}${m}${day}`;
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { value: 1 } },
    { upsert: true, new: true }
  );
  const seq = String(doc.value).padStart(4, "0");
  return `INV-${y}${m}${day}-${seq}`;
};
