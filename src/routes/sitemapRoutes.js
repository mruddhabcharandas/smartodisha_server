import express from "express";
import Product from "../models/Product.js";
import Category from "../models/Category.js";

const router = express.Router();

router.get("/sitemap.xml", async (req, res) => {
  try {
    const base = process.env.CLIENT_API_URL || process.env.API_URL || "http://localhost:5000";
    const origin = base.replace(/\/api.*$/,'').replace(/\/$/,'');
    const prods = await Product.find({ isActive: true }).select("_id updatedAt");
    const cats = await Category.find({ isActive: true }).select("name updatedAt");
    const urls = [
      { loc: `${origin}/products`, lastmod: new Date().toISOString() },
      { loc: `${origin}/about`, lastmod: new Date().toISOString() },
      { loc: `${origin}/contact`, lastmod: new Date().toISOString() }
    ];
    for (const c of cats) urls.push({ loc: `${origin}/products?category=${encodeURIComponent(c.name)}`, lastmod: c.updatedAt?.toISOString() || new Date().toISOString() });
    for (const p of prods) urls.push({ loc: `${origin}/products/${p._id}`, lastmod: p.updatedAt?.toISOString() || new Date().toISOString() });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join("\n")}
</urlset>`;
    res.setHeader("Content-Type", "application/xml");
    res.send(xml);
  } catch (e) {
    res.status(500).send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset/>");
  }
});

export default router;
