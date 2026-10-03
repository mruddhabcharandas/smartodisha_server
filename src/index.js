import express from "express";
import axios from "axios";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { connectIfConfigured } from "./lib/db.js";
import { connectRedis } from "./lib/redis.js";
import { warmCache } from "./lib/cacheWarmer.js";
import http from "http";
import { initSocket } from "./lib/socket.js";
import Admin from "./models/Admin.js";
import productRoutes from "./routes/productRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import categoryRoutes from "./routes/categoryRoutes.js";
import billRoutes from "./routes/billRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import couponRoutes from "./routes/couponRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import partnerRoutes from "./routes/partnerRoutes.js";
import publicRoutes from "./routes/publicRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import partnerAccountRoutes from "./routes/partnerAccountRoutes.js";
import cartRoutes from "./routes/cartRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import shippingRoutes from "./routes/shippingRoutes.js";
import sitemapRoutes from "./routes/sitemapRoutes.js";
import recommendationRoutes from "./routes/recommendationRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import storeRoutes from "./routes/storeRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import offerRoutes from "./routes/offerRoutes.js";
import brandRoutes from "./routes/brandRoutes.js";
import subCategoryRoutes from "./routes/subCategoryRoutes.js";
import wishlistRoutes from "./routes/wishlistRoutes.js";
import supportTicketRoutes from "./routes/supportTicketRoutes.js";
import payoutRoutes from "./routes/payoutRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from current server folder or parent project root
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const app = express();

app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://smartodisha.in",
    "https://www.smartodisha.in"
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT","PATCH", "DELETE", "OPTIONS"]
}));
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(morgan("dev"));

// Serve static files (for local uploads fallback)
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

app.get("/api/health", (req, res) => {
  res.json({ status: "uddhab das", time: new Date().toISOString() });
});

app.get("/oauth/callback", async (req, res) => {
  const { code, error, location } = req.query;
  if (error) {
    return res.status(400).send(`
      <div style="font-family:sans-serif;padding:30px;max-width:500px;margin:auto;">
        <h3 style="color:#ef4444">OAuth Authorization Error</h3>
        <pre style="background:#f1f5f9;padding:12px;border-radius:8px">${error}</pre>
      </div>
    `);
  }
  if (!code) {
    return res.send(`
      <div style="font-family:sans-serif;padding:30px;max-width:500px;margin:auto;">
        <h3 style="color:#0f172a">OAuth Callback Ready</h3>
        <p style="color:#64748b">Server is ready to receive OAuth redirect codes.</p>
      </div>
    `);
  }

  let refreshToken = null;
  let exchangeError = null;

  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const domain = (process.env.ZOHO_DOMAIN || (location === "us" || location === "com" ? "com" : "in")).toLowerCase();

  if (clientId && clientSecret) {
    try {
      const resp = await axios.post(`https://accounts.zoho.${domain}/oauth/v2/token`, null, {
        params: {
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: "https://smartodisha-server.onrender.com/oauth/callback",
          grant_type: "authorization_code"
        }
      });
      if (resp.data?.refresh_token) {
        refreshToken = resp.data.refresh_token;
      } else if (resp.data?.error) {
        exchangeError = resp.data.error;
      }
    } catch (e) {
      exchangeError = e.response?.data?.error || e.message;
    }
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Zoho Authorization Code</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 30px 16px; margin: 0; display: flex; justify-content: center; }
          .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 24px; max-width: 640px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
          h2 { color: #38bdf8; margin: 0 0 12px; font-size: 20px; }
          p { color: #94a3b8; font-size: 13px; margin: 0 0 16px; line-height: 1.5; }
          .code-box { background: #090d16; border: 1px solid #475569; padding: 12px 14px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #4ade80; word-break: break-all; margin-bottom: 12px; }
          .btn { background: #3b82f6; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; }
          .btn:hover { background: #2563eb; }
          .token-box { background: rgba(34, 197, 94, 0.1); border: 1px solid #22c55e; padding: 16px; border-radius: 12px; margin-top: 20px; }
          .token-val { color: #facc15; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>✅ Authorization Code Received!</h2>
          <p>Zoho has verified your request and returned the code below:</p>
          <div class="code-box" id="codeText">${code}</div>
          <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('codeText').innerText); alert('Code copied to clipboard!');">📋 Copy Code</button>

          ${refreshToken ? `
            <div class="token-box">
              <h3 style="color: #4ade80; margin: 0 0 8px; font-size: 16px;">🎉 Refresh Token Generated Automatically!</h3>
              <p style="color: #cbd5e1;">Copy this value and set it in your Render environment variables or server <code>.env</code> file:</p>
              <div class="code-box token-val" id="rtText">ZOHO_REFRESH_TOKEN=${refreshToken}</div>
              <button class="btn" style="background:#16a34a" onclick="navigator.clipboard.writeText('${refreshToken}'); alert('Refresh token copied to clipboard!');">📋 Copy Refresh Token</button>
            </div>
          ` : `
            <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #334155;">
              <p style="color: #cbd5e1; font-weight: 600; margin-bottom: 6px;">Next Step to get Refresh Token:</p>
              <p style="font-size: 12px;">Run this command in your terminal / Postman to exchange this code for your permanent <code>ZOHO_REFRESH_TOKEN</code>:</p>
              <div class="code-box" style="color: #38bdf8;">curl -X POST "https://accounts.zoho.${domain}/oauth/v2/token" \\<br/>
  -d "code=${code}" \\<br/>
  -d "client_id=YOUR_CLIENT_ID" \\<br/>
  -d "client_secret=YOUR_CLIENT_SECRET" \\<br/>
  -d "redirect_uri=https://smartodisha-server.onrender.com/oauth/callback" \\<br/>
  -d "grant_type=authorization_code"</div>
              ${exchangeError ? `<p style="color: #f87171; font-size: 11px;">Note: Auto-exchange attempt returned: ${JSON.stringify(exchangeError)}</p>` : ''}
            </div>
          `}
        </div>
      </body>
    </html>
  `);
});

app.use("/api/products", productRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/bills", billRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/user", userRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/partners", partnerRoutes);
app.use("/api/partner-accounts", partnerAccountRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/", sitemapRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/brands", brandRoutes);
app.use("/api/subcategories", subCategoryRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/support-tickets", supportTicketRoutes);
app.use("/api/stores", storeRoutes);
app.use("/api/admin/payouts", payoutRoutes);

const PORT = process.env.PORT || 5000;

const ensureDefaultAdmin = async () => {
  const email = process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || "Admin";

  if (!email || !password) return;

  const existing = await Admin.findOne({ email });
  if (existing) return;

  await Admin.create({ name, email, password });
  console.log(`Default admin created with email ${email}`);
};

const start = async () => {
  // Create server and start listening immediately for Render port detection
  const server = http.createServer(app);
  initSocket(server);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`server running on port ${PORT}`);
  });

  // Then do async setup in the background
  try {
    await connectIfConfigured();
    await connectRedis();
    
    // Warm cache on start (async to not block server start)
    warmCache().catch(err => console.error("Warming Error:", err));

    await ensureDefaultAdmin();

    // Start background Delhivery shipment status auto-sync (runs every 15 minutes)
    setTimeout(() => {
      import("./services/delhiveryTrackingSync.js")
        .then(({ syncAllActiveDelhiveryOrders }) => {
          syncAllActiveDelhiveryOrders().catch(e => console.error("Initial Delhivery sync warning:", e.message));
          setInterval(() => {
            syncAllActiveDelhiveryOrders().catch(e => console.error("Periodic Delhivery sync warning:", e.message));
          }, 15 * 60 * 1000);
        })
        .catch(err => console.error("Failed to initialize Delhivery sync worker:", err.message));
    }, 60 * 1000);
  } catch (err) {
    console.error("Error during server setup:", err);
  }
};

start();

export default app;
