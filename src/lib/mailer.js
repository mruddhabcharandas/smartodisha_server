import axios from "axios";

// In-memory cache for Zoho OAuth token and account details
let cachedZoho = {
  token: null,
  tokenExpiresAt: 0,
  accountId: null,
  primaryAddress: null
};

export const extractCleanEmail = (raw) => {
  if (!raw) return "";
  const match = String(raw).match(/<([^>]+)>/);
  return (match ? match[1] : String(raw)).trim();
};

export async function getAccessToken() {
  const now = Date.now();
  if (cachedZoho.token && cachedZoho.tokenExpiresAt > now) {
    return cachedZoho.token;
  }

  const domain = (process.env.ZOHO_DOMAIN || "in").toLowerCase();
  const refreshToken = (process.env.ZOHO_REFRESH_TOKEN || "").trim();
  const clientId = (process.env.ZOHO_CLIENT_ID || "").trim();
  const clientSecret = (process.env.ZOHO_CLIENT_SECRET || "").trim();

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error(
      `Zoho credentials missing in environment: refresh_token=${!!refreshToken}, client_id=${!!clientId}, client_secret=${!!clientSecret}`
    );
  }

  try {
    const res = await axios.post(`https://accounts.zoho.${domain}/oauth/v2/token`, null, {
      params: {
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token"
      }
    });

    if (!res.data?.access_token) {
      throw new Error(`Zoho token error: ${JSON.stringify(res.data)}`);
    }

    cachedZoho.token = res.data.access_token;
    const expiresIn = Number(res.data.expires_in) || 3600;
    cachedZoho.tokenExpiresAt = now + Math.max(300, expiresIn - 300) * 1000;
    return cachedZoho.token;
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error("Zoho OAuth Token fetch failed:", detail);
    throw new Error(`Zoho OAuth failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

export async function getZohoAccountInfo() {
  const domain = (process.env.ZOHO_DOMAIN || "in").toLowerCase();
  const accessToken = await getAccessToken();

  let accountId = (process.env.ZOHO_ACCOUNT_ID || cachedZoho.accountId || "").toString().trim();
  let primaryAddress = extractCleanEmail(process.env.ZOHO_MAIL_FROM || cachedZoho.primaryAddress || "");

  // Auto-discover accountId or primaryAddress if missing
  if (!accountId || !primaryAddress) {
    try {
      const accRes = await axios.get(`https://mail.zoho.${domain}/api/accounts`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`
        }
      });
      const list = accRes.data?.data;
      if (Array.isArray(list) && list.length > 0) {
        if (!accountId) {
          accountId = String(list[0].accountId || "").trim();
        }
        if (!primaryAddress) {
          primaryAddress = String(list[0].primaryAddress || list[0].incomingUserName || list[0].mailboxAddress || "").trim();
        }
      }
    } catch (e) {
      console.warn("Zoho accounts auto-discovery notice:", e?.response?.data || e.message);
    }
  }

  cachedZoho.accountId = accountId;
  cachedZoho.primaryAddress = primaryAddress;

  return { accountId, primaryAddress, domain, accessToken };
}

const COMPANY_NAME = process.env.COMPANY_NAME || "SmartOdisha";
const LOGO_URL = process.env.LOGO_URL || "https://smartodisha.in/logo.png";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://smartodisha.in";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@smartodisha.in";
const NOREPLY_EMAIL = process.env.NOREPLY_EMAIL || process.env.ZOHO_NOREPLY_EMAIL || "noreply@smartodisha.in";

/**
 * Centralized sender configuration across all transactional emails
 * SmartOdisha noreply@smartodisha.in
 */
export const CENTRALIZED_SENDER = Object.freeze({
  name: COMPANY_NAME,
  email: extractCleanEmail(NOREPLY_EMAIL) || "noreply@smartodisha.in",
  formatted: `${COMPANY_NAME} <${extractCleanEmail(NOREPLY_EMAIL) || "noreply@smartodisha.in"}>`
});

export const sendEmail = async ({ to, subject, text, html, from }) => {
  const content = html || (text ? `<pre>${text}</pre>` : "");
  try {
    const { accountId, primaryAddress, domain, accessToken } = await getZohoAccountInfo();

    if (!accountId) {
      throw new Error("Zoho Account ID is missing. Please set ZOHO_ACCOUNT_ID in environment or verify Zoho credentials.");
    }

    // Default sender is ALWAYS SmartOdisha <noreply@smartodisha.in>
    const cleanSenderEmail = extractCleanEmail(from) || CENTRALIZED_SENDER.email;
    const formattedSender = from && from.includes("<") ? from : `${CENTRALIZED_SENDER.name} <${cleanSenderEmail}>`;

    const headers = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json"
    };
    const url = `https://mail.zoho.${domain}/api/accounts/${accountId}/messages`;

    // Attempt 1: Full RFC formatted sender with display name "SmartOdisha <noreply@smartodisha.in>"
    const payload = {
      fromAddress: formattedSender,
      toAddress: to,
      subject,
      content,
      mailFormat: "html"
    };

    try {
      const res = await axios.post(url, payload, { headers });
      return { sent: true, data: res.data };
    } catch (sendErr) {
      const errData = sendErr?.response?.data;
      const errMsg = JSON.stringify(errData || sendErr.message || "").toLowerCase();

      // Attempt 2: If Zoho rejects angle brackets/display name in fromAddress, retry with pure clean email
      if (payload.fromAddress !== cleanSenderEmail) {
        console.warn(`[Zoho Mailer] Formatted sender '${formattedSender}' not accepted by Zoho endpoint. Retrying with '${cleanSenderEmail}'...`);
        payload.fromAddress = cleanSenderEmail;
        try {
          const retryRes = await axios.post(url, payload, { headers });
          return { sent: true, data: retryRes.data };
        } catch (cleanErr) {
          const cleanErrData = cleanErr?.response?.data;
          const cleanErrMsg = JSON.stringify(cleanErrData || cleanErr.message || "").toLowerCase();
          const isInvalidFrom = cleanErrData && (
            cleanErrData.code === "INVALID_FROM_ADDRESS" ||
            cleanErrData.status?.code === 400 ||
            cleanErrMsg.includes("from address") ||
            cleanErrMsg.includes("invalid_from")
          );

          if (isInvalidFrom && primaryAddress && cleanSenderEmail !== primaryAddress) {
            console.warn(`[Zoho Mailer] '${cleanSenderEmail}' is not an authorized alias in Zoho. Retrying with primary address: '${primaryAddress}'`);
            payload.fromAddress = primaryAddress;
            const fallbackRes = await axios.post(url, payload, { headers });
            return { sent: true, data: fallbackRes.data, fallbackUsed: true };
          }
          throw cleanErr;
        }
      }

      // If initial attempt was already clean address and failed due to unverified alias in Zoho
      const isInvalidFrom = errData && (
        errData.code === "INVALID_FROM_ADDRESS" ||
        errData.status?.code === 400 ||
        errMsg.includes("from address") ||
        errMsg.includes("invalid_from")
      );

      if (isInvalidFrom && primaryAddress && cleanSenderEmail !== primaryAddress) {
        console.warn(`[Zoho Mailer] '${cleanSenderEmail}' is not an authorized alias in Zoho. Retrying with primary address: '${primaryAddress}'`);
        payload.fromAddress = primaryAddress;
        const retryRes = await axios.post(url, payload, { headers });
        return { sent: true, data: retryRes.data, fallbackUsed: true };
      }

      throw sendErr;
    }
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error("Email sending failed:", detail);
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
};

/**
 * Helper to build the Master Luxury Email Wrapper
 */
const buildEmailWrapper = ({ previewText = "", badgeText = "", badgeColor = "#4f46e5", badgeBg = "#eef2ff", heading = "", subheading = "", bodyHtml = "", ctaText = "", ctaUrl = "" }) => {
  const year = new Date().getFullYear();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${heading}</title>
  <style>
    body { margin:0; padding:0; background-color:#f1f5f9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; }
    table { border-collapse:collapse; }
    img { border:0; display:block; }
    .email-container { max-width:600px; margin:24px auto; background:#ffffff; border-radius:24px; overflow:hidden; border:1px solid #e2e8f0; box-shadow:0 12px 36px rgba(15,23,42,0.06); }
    .header-gradient { background:linear-gradient(135deg, #090d16 0%, #1e1b4b 55%, #312e81 100%); padding:36px 24px; text-align:center; }
    .badge { display:inline-block; padding:6px 16px; border-radius:999px; font-size:11px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; margin-bottom:16px; }
    .content-area { padding:32px 28px; }
    .btn-primary { display:inline-block; background:linear-gradient(135deg, #4f46e5 0%, #6366f1 100%); color:#ffffff !important; padding:15px 34px; border-radius:14px; text-decoration:none; font-weight:800; font-size:14px; letter-spacing:0.04em; text-transform:uppercase; box-shadow:0 6px 20px rgba(79,70,229,0.35); text-align:center; }
    .footer-area { background:#f8fafc; border-top:1px solid #f1f5f9; padding:28px 24px; text-align:center; color:#94a3b8; font-size:12px; line-height:1.6; }
    @media only screen and (max-width: 600px) {
      .email-container { margin:10px !important; border-radius:18px !important; }
      .content-area { padding:24px 18px !important; }
    }
  </style>
</head>
<body>
  ${previewText ? `<div style="display:none;font-size:1px;color:#f1f5f9;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${previewText}</div>` : ""}

  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f5f9">
    <tr>
      <td align="center" style="padding:16px 8px;">
        <table class="email-container" width="100%" cellpadding="0" cellspacing="0" border="0">
          <!-- Header Banner -->
          <tr>
            <td class="header-gradient">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <img src="${LOGO_URL}" alt="${COMPANY_NAME}" height="46" style="height:46px; max-width:180px; object-fit:contain; margin-bottom:14px;" />
                    <div style="color:#ffffff; font-size:16px; font-weight:900; letter-spacing:0.02em;">${COMPANY_NAME}</div>
                    <div style="color:#93c5fd; font-size:11px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; margin-top:2px;">Premium Odisha Commerce</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td class="content-area">
              ${badgeText ? `
                <div style="text-align:center; margin-bottom:16px;">
                  <span class="badge" style="background:${badgeBg}; color:${badgeColor}; border:1px solid ${badgeColor}33;">${badgeText}</span>
                </div>
              ` : ""}

              ${heading ? `<h1 style="margin:0 0 10px; font-size:24px; line-height:1.25; color:#0f172a; font-weight:900; text-align:center; letter-spacing:-0.02em;">${heading}</h1>` : ""}
              ${subheading ? `<p style="margin:0 0 28px; font-size:14px; line-height:1.6; color:#64748b; text-align:center; font-weight:500;">${subheading}</p>` : ""}

              ${bodyHtml}

              ${ctaText && ctaUrl ? `
                <div style="text-align:center; margin-top:36px; margin-bottom:12px;">
                  <a href="${ctaUrl}" class="btn-primary" target="_blank">${ctaText}</a>
                </div>
              ` : ""}
            </td>
          </tr>

          <!-- Trust Bar -->
          <tr>
            <td style="padding:18px 24px; background:#f8fafc; border-top:1px solid #f1f5f9; border-bottom:1px solid #f1f5f9;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.06em; text-transform:uppercase;">
                    🔒 100% Authentic • 🚚 Delhivery Express Delivery • 💬 24x7 Support
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer Area -->
          <tr>
            <td class="footer-area">
              <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:14px; padding:16px 20px; margin-bottom:18px; text-align:center;">
                <div style="color:#0f172a; font-size:13px; font-weight:700; margin-bottom:4px;">Need Assistance?</div>
                <div style="color:#475569; font-size:12px; line-height:1.5;">
                  For any reply, support, or issue, please contact <a href="mailto:support@smartodisha.in" style="color:#4f46e5; text-decoration:underline; font-weight:700;">support@smartodisha.in</a>.
                </div>
              </div>
              <p style="margin:0 0 6px; color:#94a3b8; font-size:11px; font-weight:600;">
                Please do not reply directly to this email. This is an automated notification from a no-reply address.
              </p>
              <p style="margin:0 0 12px; color:#94a3b8; font-size:11px;">
                You received this transactional message because you are a registered user/merchant of ${COMPANY_NAME}.
              </p>
              <div style="font-size:11px; color:#cbd5e1; font-weight:700; letter-spacing:0.08em; text-transform:uppercase;">
                © ${year} ${COMPANY_NAME}. ALL RIGHTS RESERVED.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
};

/**
 * 1. Send OTP (Signup, Forgot Password, Login)
 */
export const sendOTP = async (email, otp, purpose = "ACCOUNT_VERIFICATION") => {
  const isForgot = purpose === "FORGOT_PASSWORD";
  const isSignup = purpose === "ACCOUNT_VERIFICATION" || purpose === "SIGNUP";
  const isPartner = purpose === "PARTNER_LOGIN";

  const subject = isForgot
    ? `Password Reset Code: ${otp} - ${COMPANY_NAME}`
    : isSignup
    ? `Verify Your Email: ${otp} - Welcome to ${COMPANY_NAME}!`
    : isPartner
    ? `Partner Dashboard OTP: ${otp} - ${COMPANY_NAME}`
    : `Your Verification Code: ${otp} - ${COMPANY_NAME}`;

  const badgeText = isForgot
    ? "SECURITY ALERT • PASSWORD RESET"
    : isSignup
    ? "WELCOME TO SMARTODISHA • EMAIL VERIFICATION"
    : "SECURE ACCOUNT ACCESS";

  const badgeColor = isForgot ? "#dc2626" : isSignup ? "#16a34a" : "#4f46e5";
  const badgeBg = isForgot ? "#fef2f2" : isSignup ? "#f0fdf4" : "#eef2ff";

  const heading = isForgot
    ? "Reset Your Password"
    : isSignup
    ? "Welcome! Verify Your Email"
    : "Your Login Code";

  const subheading = isForgot
    ? "We received a request to reset your password. Use the single-use verification code below to proceed."
    : isSignup
    ? "Thank you for creating an account with SmartOdisha! Enter the 4-digit code below to activate your account."
    : "Use the one-time authorization code below to complete your login securely.";

  const bodyHtml = `
    <div style="background:#090d16; border-radius:20px; padding:32px 20px; text-align:center; margin:24px 0; border:1px solid #1e293b; box-shadow:0 8px 24px rgba(15,23,42,0.18);">
      <div style="font-size:11px; font-weight:800; letter-spacing:0.2em; text-transform:uppercase; color:#94a3b8; margin-bottom:10px;">Verification Code</div>
      <div style="font-size:42px; font-weight:900; letter-spacing:14px; color:#ffffff; font-family:monospace; margin-left:14px;">${otp}</div>
      <div style="margin-top:14px; display:inline-block; background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3); padding:4px 14px; border-radius:999px; font-size:11px; font-weight:700;">
        ⏳ Valid for 10 minutes only
      </div>
    </div>

    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:18px 20px; margin-top:24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="28" valign="top" style="font-size:18px; line-height:1;">🛡️</td>
          <td style="font-size:12px; color:#475569; line-height:1.6; padding-left:10px;">
            <strong>Security Notice:</strong> Never share this OTP with anyone, including customer support agents. SmartOdisha will never ask for your code. If you did not make this request, please disregard this email.
          </td>
        </tr>
      </table>
    </div>
  `;

  const html = buildEmailWrapper({
    previewText: `Your ${COMPANY_NAME} verification code is ${otp}. Valid for 10 minutes.`,
    badgeText,
    badgeColor,
    badgeBg,
    heading,
    subheading,
    bodyHtml
  });

  return sendEmail({ to: email, subject, html });
};

/**
 * 2. New User Welcome Email (Triggered after successful Signup)
 */
export const sendUserWelcomeEmail = async (email, name = "Customer") => {
  const subject = `Welcome to ${COMPANY_NAME}, ${name}! 🎉 Your Account is Ready`;

  const bodyHtml = `
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:20px; padding:24px; margin-bottom:24px;">
      <h3 style="margin:0 0 8px; color:#0f172a; font-size:16px; font-weight:800;">Hi ${name}, welcome to the family!</h3>
      <p style="margin:0; font-size:14px; color:#475569; line-height:1.6;">
        We are thrilled to have you with us. SmartOdisha connects you directly with verified sellers, authentic regional artisans, and trusted brands across Odisha with express delivery to your doorstep.
      </p>
    </div>

    <!-- Feature Grid -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
      <tr>
        <td width="50%" valign="top" style="padding-right:8px; padding-bottom:16px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:16px; height:100%;">
            <div style="font-size:24px; margin-bottom:8px;">🚚</div>
            <div style="font-size:13px; font-weight:800; color:#0f172a; margin-bottom:4px;">Express Delivery</div>
            <div style="font-size:12px; color:#64748b; line-height:1.5;">Direct shipments powered by Delhivery B2C with live tracking.</div>
          </div>
        </td>
        <td width="50%" valign="top" style="padding-left:8px; padding-bottom:16px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:16px; height:100%;">
            <div style="font-size:24px; margin-bottom:8px;">🎨</div>
            <div style="font-size:13px; font-weight:800; color:#0f172a; margin-bottom:4px;">100% Authentic</div>
            <div style="font-size:12px; color:#64748b; line-height:1.5;">Handcrafted handlooms, regional specialties, and premium products.</div>
          </div>
        </td>
      </tr>
      <tr>
        <td width="50%" valign="top" style="padding-right:8px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:16px; height:100%;">
            <div style="font-size:24px; margin-bottom:8px;">💳</div>
            <div style="font-size:13px; font-weight:800; color:#0f172a; margin-bottom:4px;">Safe Payments</div>
            <div style="font-size:12px; color:#64748b; line-height:1.5;">Cashfree secured UPI, credit/debit cards, and Cash on Delivery.</div>
          </div>
        </td>
        <td width="50%" valign="top" style="padding-left:8px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:16px; height:100%;">
            <div style="font-size:24px; margin-bottom:8px;">💬</div>
            <div style="font-size:13px; font-weight:800; color:#0f172a; margin-bottom:4px;">24x7 Customer Care</div>
            <div style="font-size:12px; color:#64748b; line-height:1.5;">Dedicated support team ready to assist with orders and inquiries.</div>
          </div>
        </td>
      </tr>
    </table>
  `;

  const html = buildEmailWrapper({
    previewText: `Welcome to SmartOdisha, ${name}! Start exploring authentic products and fast delivery today.`,
    badgeText: "NEW MEMBER WELCOME ✨",
    badgeColor: "#4f46e5",
    badgeBg: "#eef2ff",
    heading: `Welcome to SmartOdisha, ${name}!`,
    subheading: "Your account is active. Discover authentic collections and exclusive offers.",
    bodyHtml,
    ctaText: "Start Shopping Now 🛍️",
    ctaUrl: `${FRONTEND_URL}/`
  });

  return sendEmail({ to: email, subject, html });
};

/**
 * 3. Customer Order Confirmation Email (Sent on Order Placed / Payment Verified)
 */
export const sendCustomerOrderConfirmationEmail = async (order) => {
  if (!order || !order.customer?.email) return;

  const orderNum = order.orderNumber || String(order._id).slice(-8).toUpperCase();
  const customerName = order.customer?.name || "Valued Customer";
  const subject = `Order Confirmed: #${orderNum} - ${COMPANY_NAME}`;

  const itemsHtml = (order.items || []).map(it => {
    const attrText = it.attributes && typeof it.attributes === 'object'
      ? Object.entries(it.attributes).map(([k, v]) => `${k}: ${v}`).join(" • ")
      : (it.variantSku ? `SKU: ${it.variantSku}` : "");

    const productUrl = it.product ? `${FRONTEND_URL}/products/${it.product}` : `${FRONTEND_URL}/products`;

    return `
      <tr>
        <td style="padding:14px 0; border-bottom:1px solid #f1f5f9;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              ${it.image ? `
                <td width="56" valign="top" style="padding-right:14px;">
                  <a href="${productUrl}" target="_blank" style="text-decoration:none; display:block;">
                    <img src="${it.image}" alt="${it.name}" width="56" height="56" style="width:56px; height:56px; object-fit:cover; border-radius:12px; border:1px solid #e2e8f0;" />
                  </a>
                </td>
              ` : ""}
              <td valign="top">
                <div style="font-size:13px; font-weight:800; color:#0f172a; line-height:1.4;">
                  <a href="${productUrl}" target="_blank" style="color:#0f172a; text-decoration:none; font-weight:800;">${it.name}</a>
                </div>
                ${attrText ? `<div style="font-size:11px; color:#64748b; font-weight:600; margin-top:2px;">${attrText}</div>` : ""}
                <div style="font-size:12px; color:#94a3b8; font-weight:700; margin-top:4px;">Qty: ${it.quantity}</div>
              </td>
              <td width="90" align="right" valign="top">
                <div style="font-size:14px; font-weight:900; color:#0f172a;">₹${Number(it.lineTotal || (it.price * it.quantity)).toLocaleString("en-IN")}</div>
                ${it.quantity > 1 ? `<div style="font-size:10px; color:#94a3b8;">(₹${Number(it.price).toLocaleString("en-IN")} each)</div>` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `;
  }).join("");

  const subtotal = order.productTotal || order.items.reduce((s, it) => s + (it.lineTotal || it.price * it.quantity), 0);
  const discount = order.couponDiscount || 0;
  const shipping = order.shippingCost || 0;
  const grandTotal = order.totalEstimate || 0;
  const codDue = order.codDueAmount || 0;

  const addr = order.shippingAddress || {};
  const addrText = [addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(", ");

  const bodyHtml = `
    <!-- Order Highlight Card -->
    <div style="background:#090d16; border-radius:20px; padding:22px; margin-bottom:26px; border:1px solid #1e293b;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td>
            <div style="font-size:10px; font-weight:800; letter-spacing:0.15em; text-transform:uppercase; color:#94a3b8;">Order Number</div>
            <div style="font-size:20px; font-weight:900; color:#ffffff; margin-top:2px; font-family:monospace;">#${orderNum}</div>
          </td>
          <td align="right">
            <div style="font-size:10px; font-weight:800; letter-spacing:0.15em; text-transform:uppercase; color:#94a3b8;">Total Amount</div>
            <div style="font-size:22px; font-weight:900; color:#4ade80; margin-top:2px;">₹${Number(grandTotal).toLocaleString("en-IN")}</div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Items Section -->
    <div style="margin-bottom:28px;">
      <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#64748b; margin-bottom:12px;">Items in Your Order</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${itemsHtml}
      </table>
    </div>

    <!-- Price Breakdown Card -->
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:18px; padding:20px; margin-bottom:26px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-size:13px; color:#64748b; padding-bottom:8px; font-weight:600;">Items Subtotal</td>
          <td align="right" style="font-size:13px; color:#0f172a; padding-bottom:8px; font-weight:800;">₹${Number(subtotal).toLocaleString("en-IN")}</td>
        </tr>
        ${discount > 0 ? `
          <tr>
            <td style="font-size:13px; color:#16a34a; padding-bottom:8px; font-weight:700;">Coupon Discount (${order.couponCode || 'APPLIED'})</td>
            <td align="right" style="font-size:13px; color:#16a34a; padding-bottom:8px; font-weight:800;">-₹${Number(discount).toLocaleString("en-IN")}</td>
          </tr>
        ` : ""}
        <tr>
          <td style="font-size:13px; color:#64748b; padding-bottom:8px; font-weight:600;">Delivery & Handling</td>
          <td align="right" style="font-size:13px; color:#0f172a; padding-bottom:8px; font-weight:800;">${shipping > 0 ? `₹${Number(shipping).toLocaleString("en-IN")}` : '<span style="color:#16a34a;">FREE</span>'}</td>
        </tr>
        <tr>
          <td style="padding-top:12px; border-top:1px solid #e2e8f0; font-size:15px; font-weight:900; color:#0f172a;">Grand Total</td>
          <td align="right" style="padding-top:12px; border-top:1px solid #e2e8f0; font-size:18px; font-weight:900; color:#4f46e5;">₹${Number(grandTotal).toLocaleString("en-IN")}</td>
        </tr>
        ${order.paymentMethod === "COD" && codDue > 0 ? `
          <tr>
            <td colspan="2" style="padding-top:12px;">
              <div style="background:#fef3c7; border:1px solid #fde68a; border-radius:10px; padding:10px 14px; font-size:12px; color:#92400e; font-weight:700;">
                💵 Balance to Pay on Delivery: <strong>₹${Number(codDue).toLocaleString("en-IN")}</strong>
              </div>
            </td>
          </tr>
        ` : ""}
      </table>
    </div>

    <!-- Shipping Address & Payment Card -->
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:18px; padding:20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="top" width="55%" style="padding-right:14px;">
            <div style="font-size:10px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#94a3b8; margin-bottom:4px;">Delivery Address</div>
            <div style="font-size:13px; font-weight:800; color:#0f172a;">${customerName}</div>
            <div style="font-size:12px; color:#64748b; line-height:1.5; margin-top:2px;">${addrText || "Address on file"}</div>
            ${order.customer?.phone ? `<div style="font-size:12px; color:#64748b; margin-top:4px;">📞 ${order.customer.phone}</div>` : ""}
          </td>
          <td valign="top" width="45%" style="border-left:1px solid #e2e8f0; padding-left:14px;">
            <div style="font-size:10px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#94a3b8; margin-bottom:4px;">Payment Method</div>
            <div style="font-size:13px; font-weight:800; color:#0f172a;">${order.paymentMethod === "COD" ? "Cash on Delivery" : "Online Pre-paid (Cashfree)"}</div>
            <div style="font-size:11px; color:#16a34a; font-weight:700; margin-top:4px;">● Payment ${order.paymentStatus}</div>
            <div style="font-size:10px; color:#94a3b8; margin-top:8px; font-weight:700; text-transform:uppercase;">Carrier: Delhivery Express</div>
          </td>
        </tr>
      </table>
    </div>
  `;

  const html = buildEmailWrapper({
    previewText: `Your SmartOdisha order #${orderNum} is confirmed! Total: ₹${grandTotal}. Track live status inside.`,
    badgeText: "ORDER CONFIRMED 🎉",
    badgeColor: "#16a34a",
    badgeBg: "#f0fdf4",
    heading: `Thank you for your order, ${customerName}!`,
    subheading: `Your order #${orderNum} has been received and our verified seller is preparing it for shipment.`,
    bodyHtml,
    ctaText: "Track Your Order 🚚",
    ctaUrl: `${FRONTEND_URL}/orders`
  });

  return sendEmail({ to: order.customer.email, subject, html });
};

/**
 * 4. Seller New Order Alert Email (Sent to store owner when an order is placed)
 */
export const sendSellerNewOrderAlertEmail = async (sellerEmail, sellerName = "Seller Partner", order) => {
  if (!sellerEmail || !order) return;

  const orderNum = order.orderNumber || String(order._id).slice(-8).toUpperCase();
  const subject = `🚨 Action Required: New Order #${orderNum} Received! - ${COMPANY_NAME}`;

  const totalQty = (order.items || []).reduce((s, it) => s + (it.quantity || 1), 0);
  const sellerPayout = order.storeRevenue || order.items.reduce((s, it) => s + (it.originalStorePrice * it.quantity), 0);

  const itemsRows = (order.items || []).map(it => {
    const attrText = it.attributes && typeof it.attributes === 'object'
      ? Object.entries(it.attributes).map(([k, v]) => `${k}: ${v}`).join(" • ")
      : (it.variantSku ? `SKU: ${it.variantSku}` : "");

    const productUrl = it.product ? `${FRONTEND_URL}/products/${it.product}` : `${FRONTEND_URL}/business/products`;

    return `
      <tr>
        <td style="padding:10px 0; border-bottom:1px solid #f1f5f9; font-size:13px; font-weight:700; color:#0f172a;">
          <a href="${productUrl}" target="_blank" style="color:#0f172a; text-decoration:none; font-weight:700;">${it.name}</a>
          ${attrText ? `<div style="font-size:11px; font-weight:600; color:#64748b; margin-top:2px;">${attrText}</div>` : ""}
        </td>
        <td align="center" style="padding:10px 0; border-bottom:1px solid #f1f5f9; font-size:13px; font-weight:800; color:#0f172a;">
          <span style="background:#eef2ff; color:#4f46e5; padding:3px 10px; border-radius:999px;">${it.quantity}</span>
        </td>
      </tr>
    `;
  }).join("");

  const destCity = order.shippingAddress?.city || "Odisha";
  const destPin = order.shippingAddress?.pincode || "";

  const bodyHtml = `
    <!-- Seller Payout Highlight Card -->
    <div style="background:linear-gradient(135deg, #1e1b4b 0%, #312e81 100%); border-radius:20px; padding:24px; margin-bottom:24px; color:#ffffff;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td>
            <div style="font-size:10px; font-weight:800; letter-spacing:0.18em; text-transform:uppercase; color:#cbd5e1;">Your Estimated Earnings</div>
            <div style="font-size:28px; font-weight:900; color:#facc15; margin-top:2px;">₹${Number(sellerPayout).toLocaleString("en-IN")}</div>
          </td>
          <td align="right">
            <div style="font-size:10px; font-weight:800; letter-spacing:0.18em; text-transform:uppercase; color:#cbd5e1;">Order Number</div>
            <div style="font-size:18px; font-weight:900; color:#ffffff; font-family:monospace; margin-top:2px;">#${orderNum}</div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Quick Stats Grid -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
      <tr>
        <td width="33%" style="padding-right:6px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:12px; text-align:center;">
            <div style="font-size:10px; font-weight:700; color:#94a3b8; text-transform:uppercase;">Total Items</div>
            <div style="font-size:16px; font-weight:900; color:#0f172a; margin-top:2px;">${totalQty}</div>
          </div>
        </td>
        <td width="33%" style="padding:0 3px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:12px; text-align:center;">
            <div style="font-size:10px; font-weight:700; color:#94a3b8; text-transform:uppercase;">Destination</div>
            <div style="font-size:13px; font-weight:800; color:#0f172a; margin-top:4px;">${destCity} ${destPin ? `(${destPin})` : ''}</div>
          </div>
        </td>
        <td width="33%" style="padding-left:6px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:12px; text-align:center;">
            <div style="font-size:10px; font-weight:700; color:#94a3b8; text-transform:uppercase;">Payment</div>
            <div style="font-size:13px; font-weight:800; color:#16a34a; margin-top:4px;">${order.paymentMethod}</div>
          </div>
        </td>
      </tr>
    </table>

    <!-- Packing Checklist -->
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:18px; padding:20px; margin-bottom:24px;">
      <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#64748b; margin-bottom:12px;">Items to Pack & Prepare:</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <thead>
          <tr>
            <th align="left" style="font-size:10px; font-weight:800; color:#94a3b8; text-transform:uppercase; padding-bottom:8px; border-bottom:2px solid #e2e8f0;">Product Title</th>
            <th align="center" style="font-size:10px; font-weight:800; color:#94a3b8; text-transform:uppercase; padding-bottom:8px; border-bottom:2px solid #e2e8f0;">Qty</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>
    </div>

    <!-- Fulfillment Instructions -->
    <div style="background:#fef3c7; border:1px solid #fde68a; border-radius:16px; padding:16px; font-size:12px; color:#92400e; line-height:1.6;">
      📦 <strong>Next Steps:</strong> Log into your Seller Portal, verify the stock, click <strong>"Print Delhivery Label"</strong>, attach the shipping barcode to the package, and hand it over to the Delhivery pickup agent.
    </div>
  `;

  const html = buildEmailWrapper({
    previewText: `New Order #${orderNum}! You have ${totalQty} items to pack. Payout: ₹${sellerPayout}.`,
    badgeText: "NEW ORDER ALERT ⚡",
    badgeColor: "#ea580c",
    badgeBg: "#fff7ed",
    heading: `New Order Received!`,
    subheading: `Hi ${sellerName}, you have received a new purchase. Please fulfill this order promptly.`,
    bodyHtml,
    ctaText: "Open Seller Hub to Fulfill 📦",
    ctaUrl: `${FRONTEND_URL}/business/orders`
  });

  return sendEmail({ to: sellerEmail, subject, html });
};

/**
 * 5. Customer Order Status Update Email (Shipped, Out for Delivery, Delivered, Cancelled)
 */
export const sendCustomerOrderStatusUpdateEmail = async (order, targetStatus, customDetails = {}) => {
  if (!order || !order.customer?.email) return;

  const orderNum = order.orderNumber || String(order._id).slice(-8).toUpperCase();
  const customerName = order.customer?.name || "Customer";
  const waybill = order.shipping?.waybill || order.delhiveryWaybill || "";
  const trackingUrl = order.shipping?.trackingUrl || (waybill ? `https://www.delhivery.com/track/package/${waybill}` : "");

  let badgeText = "ORDER UPDATE";
  let badgeColor = "#4f46e5";
  let badgeBg = "#eef2ff";
  let heading = `Order Update: #${orderNum}`;
  let subheading = `Your order status has been updated.`;
  let subject = `Update on your SmartOdisha Order #${orderNum}`;
  let ctaText = "View Order Details";
  let ctaUrl = `${FRONTEND_URL}/orders`;

  let statusCardContent = "";

  switch (targetStatus) {
    case "CONFIRMED":
      subject = `🎉 Order Confirmed! SmartOdisha #${orderNum}`;
      badgeText = "ORDER CONFIRMED 🎉";
      badgeColor = "#16a34a";
      badgeBg = "#f0fdf4";
      heading = "Your Order is Confirmed!";
      subheading = `Thank you, ${customerName}! Your order #${orderNum} has been confirmed and the seller is preparing your package.`;
      ctaText = "View Order Details 📄";
      ctaUrl = `${FRONTEND_URL}/orders`;

      statusCardContent = `
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:18px; padding:20px; margin-bottom:24px;">
          <div style="font-size:14px; font-weight:800; color:#166534; margin-bottom:4px;">✅ Order Verified & Assigned</div>
          <div style="font-size:12px; color:#15803d; line-height:1.5;">
            The seller has accepted your order and our fulfillment team has scheduled Delhivery logistics for shipment.
          </div>
        </div>
      `;
      break;

    case "PROCESSING":
      subject = `⚙️ Preparing Your Order: SmartOdisha #${orderNum}`;
      badgeText = "ORDER PROCESSING ⚙️";
      badgeColor = "#4f46e5";
      badgeBg = "#eef2ff";
      heading = "Your Items are Being Prepared";
      subheading = `Hi ${customerName}, the seller has started picking and quality-checking your items for order #${orderNum}.`;
      ctaText = "View Order Status 🔍";
      ctaUrl = `${FRONTEND_URL}/orders`;

      statusCardContent = `
        <div style="background:#eef2ff; border:1px solid #c7d2fe; border-radius:18px; padding:20px; margin-bottom:24px;">
          <div style="font-size:14px; font-weight:800; color:#4338ca; margin-bottom:4px;">🔍 Assembly & Quality Inspection</div>
          <div style="font-size:12px; color:#3730a3; line-height:1.5;">
            Your items are undergoing authentic quality inspection prior to packaging. We'll alert you the moment they are boxed!
          </div>
        </div>
      `;
      break;

    case "PACKED":
      subject = `📦 Order Packed & Ready! SmartOdisha #${orderNum}`;
      badgeText = "PACKED & READY 📦";
      badgeColor = "#0891b2";
      badgeBg = "#ecfeff";
      heading = "Your Package is Packed!";
      subheading = `Great news, ${customerName}! Your order #${orderNum} is safely packed and waiting for Delhivery courier pickup.`;
      ctaText = "Track Order 🚚";
      ctaUrl = `${FRONTEND_URL}/orders`;

      statusCardContent = `
        <div style="background:#ecfeff; border:1px solid #a5f3fc; border-radius:18px; padding:20px; margin-bottom:24px;">
          <div style="font-size:14px; font-weight:800; color:#155e75; margin-bottom:4px;">📦 Sealed and Ready for Courier Handover</div>
          <div style="font-size:12px; color:#0e7490; line-height:1.5;">
            The shipping label with barcode has been attached. The Delhivery dispatch executive will pick up your parcel shortly.
          </div>
        </div>
      `;
      break;

    case "SHIPPED":
      subject = `🚚 Order Dispatched! SmartOdisha #${orderNum} is on the way`;
      badgeText = "DISPATCHED & IN TRANSIT 🚚";
      badgeColor = "#2563eb";
      badgeBg = "#eff6ff";
      heading = "Your Order is on the Way!";
      subheading = `Great news, ${customerName}! Your package has been handed over to Delhivery Express for fast delivery.`;
      ctaText = "Track Package Live 📍";
      ctaUrl = trackingUrl || `${FRONTEND_URL}/orders`;

      statusCardContent = `
        <div style="background:#090d16; border-radius:18px; padding:22px; margin-bottom:24px; color:#ffffff; border:1px solid #1e293b;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td>
                <div style="font-size:10px; font-weight:800; letter-spacing:0.15em; text-transform:uppercase; color:#94a3b8;">Courier Partner</div>
                <div style="font-size:16px; font-weight:900; color:#38bdf8; margin-top:2px;">DELHIVERY B2C EXPRESS</div>
              </td>
              ${waybill ? `
                <td align="right">
                  <div style="font-size:10px; font-weight:800; letter-spacing:0.15em; text-transform:uppercase; color:#94a3b8;">Waybill / AWB No.</div>
                  <div style="font-size:16px; font-weight:900; color:#4ade80; font-family:monospace; margin-top:2px;">
                    ${trackingUrl ? `<a href="${trackingUrl}" target="_blank" style="color:#4ade80; text-decoration:underline;">${waybill}</a>` : waybill}
                  </div>
                </td>
              ` : ""}
            </tr>
          </table>
        </div>
      `;
      break;

    case "OUT_FOR_DELIVERY":
      subject = `🛵 Out for Delivery Today! SmartOdisha #${orderNum}`;
      badgeText = "ARRIVING TODAY 🛵";
      badgeColor = "#d97706";
      badgeBg = "#fffbeb";
      heading = "Your Package Arrives Today!";
      subheading = `The Delhivery delivery executive is out with your package and will deliver it today.`;
      ctaText = "Track Delivery Executive 📍";
      ctaUrl = trackingUrl || `${FRONTEND_URL}/orders`;

      statusCardContent = `
        <div style="background:#fef3c7; border:1px solid #fde68a; border-radius:18px; padding:20px; margin-bottom:24px;">
          <div style="font-size:14px; font-weight:800; color:#92400e; margin-bottom:4px;">📦 Expected Delivery: Today</div>
          <div style="font-size:12px; color:#78350f; line-height:1.5;">
            Please ensure someone is available at the delivery address to receive the parcel.
            ${order.paymentMethod === "COD" && order.codDueAmount > 0 ? `<br/><br/>💵 <strong>Cash on Delivery Reminder:</strong> Please keep <strong>₹${Number(order.codDueAmount).toLocaleString("en-IN")}</strong> ready in cash or UPI for the courier agent.` : ""}
          </div>
        </div>
      `;
      break;

    case "DELIVERED":
      subject = `✨ Order Delivered! SmartOdisha #${orderNum}`;
      badgeText = "DELIVERED SUCCESSFULLY ✨";
      badgeColor = "#16a34a";
      badgeBg = "#f0fdf4";
      heading = "Your Package has been Delivered!";
      subheading = `We hope you love your purchase from SmartOdisha. Thank you for shopping with us!`;
      ctaText = "Rate Your Purchase ⭐";
      ctaUrl = `${FRONTEND_URL}/orders`;

      statusCardContent = `
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:18px; padding:20px; margin-bottom:24px; text-align:center;">
          <div style="font-size:36px; margin-bottom:8px;">🎁</div>
          <div style="font-size:15px; font-weight:900; color:#166534; margin-bottom:4px;">Delivered by Delhivery Express</div>
          <div style="font-size:12px; color:#15803d;">We would love to hear your feedback on the products you received!</div>
        </div>
      `;
      break;

    case "RETURNED":
      subject = `↩️ Return Processed: SmartOdisha #${orderNum}`;
      badgeText = "RETURN PROCESSED ↩️";
      badgeColor = "#64748b";
      badgeBg = "#f1f5f9";
      heading = "Return Package Received";
      subheading = `Your returned parcel for order #${orderNum} has been received back at the facility.`;
      ctaText = "View Orders 📦";
      ctaUrl = `${FRONTEND_URL}/orders`;

      statusCardContent = `
        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:18px; padding:20px; margin-bottom:24px;">
          <div style="font-size:14px; font-weight:800; color:#334155; margin-bottom:4px;">📦 Return Received & Checked</div>
          <div style="font-size:12px; color:#475569; line-height:1.5;">
            The items have been verified upon return. Any applicable refunds or wallet credits are being processed per policy.
          </div>
        </div>
      `;
      break;

    case "CANCELLED":
      subject = `❌ Order Cancelled: SmartOdisha #${orderNum}`;
      badgeText = "ORDER CANCELLED";
      badgeColor = "#dc2626";
      badgeBg = "#fef2f2";
      heading = "Your Order has been Cancelled";
      subheading = `Order #${orderNum} has been cancelled.`;
      ctaText = "Visit Storefront";
      ctaUrl = `${FRONTEND_URL}/`;

      statusCardContent = `
        <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:18px; padding:20px; margin-bottom:24px;">
          <div style="font-size:13px; font-weight:800; color:#991b1b; margin-bottom:4px;">Reason for Cancellation:</div>
          <div style="font-size:12px; color:#b91c1c; line-height:1.5;">${customDetails.reason || order.refundReason || "Cancelled upon request"}</div>
          ${order.refundAmount > 0 ? `
            <div style="margin-top:12px; padding-top:12px; border-top:1px solid #fee2e2; font-size:12px; color:#991b1b;">
              💰 <strong>Refund Status:</strong> A refund of <strong>₹${Number(order.refundAmount).toLocaleString("en-IN")}</strong> has been initiated to your original payment method. It usually reflects within 2-5 business days.
            </div>
          ` : ""}
        </div>
      `;
      break;

    default:
      break;
  }

  const bodyHtml = `
    ${statusCardContent}

    <!-- Order Summary Recap -->
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:18px; padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td>
            <div style="font-size:11px; font-weight:800; text-transform:uppercase; color:#94a3b8;">Order ID</div>
            <div style="font-size:14px; font-weight:800; color:#0f172a; margin-top:2px;">
              <a href="${FRONTEND_URL}/orders" target="_blank" style="color:#4f46e5; text-decoration:none; font-family:monospace; font-weight:900;">#${orderNum}</a>
            </div>
          </td>
          <td align="right">
            <div style="font-size:11px; font-weight:800; text-transform:uppercase; color:#94a3b8;">Total Items</div>
            <div style="font-size:14px; font-weight:800; color:#0f172a; margin-top:2px;">${(order.items || []).length} Product(s)</div>
          </td>
        </tr>
      </table>
    </div>
  `;

  const html = buildEmailWrapper({
    previewText: `${heading} - SmartOdisha Order #${orderNum}`,
    badgeText,
    badgeColor,
    badgeBg,
    heading,
    subheading,
    bodyHtml,
    ctaText,
    ctaUrl
  });

  return sendEmail({ to: order.customer.email, subject, html });
};

/**
 * 6. Password Changed Security Confirmation Email
 */
export const sendPasswordChangedEmail = async (email, name = "User") => {
  const subject = `Security Alert: Your Password Has Been Changed - ${COMPANY_NAME}`;

  const bodyHtml = `
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:18px; padding:22px; margin-bottom:24px;">
      <h3 style="margin:0 0 8px; color:#0f172a; font-size:15px; font-weight:800;">Hi ${name},</h3>
      <p style="margin:0; font-size:13px; color:#475569; line-height:1.6;">
        Your password for your SmartOdisha account was successfully updated on <strong>${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</strong>.
      </p>
    </div>

    <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:16px; padding:16px; font-size:12px; color:#991b1b; line-height:1.6;">
      ⚠️ <strong>Didn't make this change?</strong><br/>
      If you did not initiate this change, your account may be compromised. Please reset your password immediately or reach out to our emergency support at <a href="mailto:${SUPPORT_EMAIL}" style="color:#b91c1c; font-weight:800;">${SUPPORT_EMAIL}</a>.
    </div>
  `;

  const html = buildEmailWrapper({
    previewText: `Your SmartOdisha account password was successfully changed.`,
    badgeText: "SECURITY CONFIRMATION 🛡️",
    badgeColor: "#16a34a",
    badgeBg: "#f0fdf4",
    heading: "Password Changed Successfully",
    subheading: "Your security credentials have been updated.",
    bodyHtml,
    ctaText: "Login to Your Account",
    ctaUrl: `${FRONTEND_URL}/login`
  });

  return sendEmail({ to: email, subject, html });
};

/**
 * 7. Seller Approval Greeting
 */
export const sendSellerGreeting = async (email, sellerName = "Seller Partner") => {
  const subject = `🎉 Congratulations, ${sellerName}! Your Store is Approved on ${COMPANY_NAME}`;

  const bodyHtml = `
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:20px; padding:24px; margin-bottom:24px;">
      <h3 style="margin:0 0 8px; color:#0f172a; font-size:16px; font-weight:800;">Welcome to the Seller Family!</h3>
      <p style="margin:0; font-size:14px; color:#475569; line-height:1.6;">
        Your seller application has been approved by the SmartOdisha admin team. Your storefront is now active and ready to reach thousands of customers across Odisha.
      </p>
    </div>

    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:18px; padding:20px; margin-bottom:24px;">
      <div style="font-size:12px; font-weight:800; color:#0f172a; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:12px;">Quick Start Guide:</div>
      <ul style="margin:0; padding-left:20px; color:#475569; font-size:13px; line-height:1.8;">
        <li>Upload your products and catalog images in <strong>Products Catalog</strong></li>
        <li>Set up your product variations using our new <strong>Variant Studio</strong></li>
        <li>Ensure your pickup address and Delhivery dispatch pin is verified</li>
        <li>Check <strong>Earnings & Payouts</strong> to configure bank transfer details</li>
      </ul>
    </div>
  `;

  const html = buildEmailWrapper({
    previewText: `Your store ${sellerName} has been approved on SmartOdisha! Start listing products today.`,
    badgeText: "SELLER PARTNER APPROVED 🌟",
    badgeColor: "#16a34a",
    badgeBg: "#f0fdf4",
    heading: `Congratulations, ${sellerName}!`,
    subheading: `Your verified seller account is now live. Welcome aboard!`,
    bodyHtml,
    ctaText: "Go to Seller Dashboard 🚀",
    ctaUrl: `${FRONTEND_URL}/business/login`
  });

  return sendEmail({ to: email, subject, html });
};

/**
 * 8. Legacy / Fallback renderMail for backwards compatibility
 */
export const renderMail = ({ heading, subheading, blocks, highlight, items, totals, ctaUrl, ctaText }) => {
  const blocksHtml = (blocks || []).map(({ label, value }) => `
    <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #f1f5f9;">
      <div style="font-size:11px; color:#94a3b8; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">${label}</div>
      <div style="font-size:13px; color:#0f172a; font-weight:800; text-align:right;">${value}</div>
    </div>
  `).join("");

  const itemsHtml = Array.isArray(items) && items.length ? `
    <div style="margin-top:24px; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden;">
      <table width="100%" cellpadding="12" cellspacing="0" border="0" style="background:#f8fafc; font-size:11px; font-weight:800; color:#64748b; text-transform:uppercase;">
        <tr>
          <td align="left">Product</td>
          <td align="center" width="50">Qty</td>
          <td align="right" width="90">Total</td>
        </tr>
      </table>
      <table width="100%" cellpadding="12" cellspacing="0" border="0" style="background:#ffffff; font-size:13px; color:#0f172a;">
        ${items.map(it => `
          <tr style="border-top:1px solid #f1f5f9;">
            <td align="left" style="font-weight:700;">${it.name}</td>
            <td align="center" style="font-weight:800; color:#4f46e5;">${it.quantity}</td>
            <td align="right" style="font-weight:800;">₹${Number(it.lineTotal || (it.price * it.quantity)).toLocaleString("en-IN")}</td>
          </tr>
        `).join("")}
      </table>
    </div>
  ` : "";

  const highlightHtml = highlight ? `
    <div style="background:#eef2ff; border:1px solid #c7d2fe; color:#4338ca; padding:14px; border-radius:14px; text-align:center; font-weight:800; font-size:14px; margin-bottom:20px;">
      ${highlight}
    </div>
  ` : "";

  const bodyHtml = `
    ${highlightHtml}
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:18px; padding:20px; margin-bottom:20px;">
      ${blocksHtml}
    </div>
    ${itemsHtml}
  `;

  return buildEmailWrapper({
    heading,
    subheading,
    bodyHtml,
    ctaText: ctaText || "",
    ctaUrl: ctaUrl || ""
  });
};

export const sendPasswordResetEmail = async (email, name, resetUrl) => {
  const subject = `Reset Your Password - ${COMPANY_NAME}`;
  const bodyHtml = `
    <p style="font-size:14px; color:#475569; line-height:1.6; margin-bottom:24px;">
      Hi ${name},<br/><br/>
      We received a request to reset your password. Click the secure button below to set a new password. This link is valid for 1 hour.
    </p>
  `;

  const html = buildEmailWrapper({
    previewText: `Reset your SmartOdisha password.`,
    badgeText: "SECURITY ALERT",
    badgeColor: "#dc2626",
    badgeBg: "#fef2f2",
    heading: "Reset Your Password",
    subheading: "Click below to securely change your password.",
    bodyHtml,
    ctaText: "Reset Password 🔒",
    ctaUrl: resetUrl
  });

  return sendEmail({ to: email, subject, html });
};

/**
 * 9. Seller Payout Processed Email (Detailed disbursement statement)
 */
export const sendSellerPayoutProcessedEmail = async ({
  sellerEmail,
  sellerName = "Seller Partner",
  amount,
  referenceId = "",
  note = "",
  remainingPending = 0,
  totalPaid = 0,
  bankDetails = null,
  upiId = ""
}) => {
  if (!sellerEmail) return;

  const formattedAmount = Number(amount || 0).toLocaleString("en-IN");
  const formattedPending = Number(remainingPending || 0).toLocaleString("en-IN");
  const formattedTotalPaid = Number(totalPaid || 0).toLocaleString("en-IN");
  const dateStr = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  const subject = `💰 Payout Disbursed: ₹${formattedAmount} Transferred - ${COMPANY_NAME}`;

  let accountDestHtml = "";
  if (upiId && upiId.trim()) {
    accountDestHtml = `
      <div style="font-size:12px; font-weight:700; color:#0f172a;">UPI ID: <span style="font-family:monospace; color:#4f46e5;">${upiId.trim()}</span></div>
    `;
  } else if (bankDetails && (bankDetails.accountNumber || bankDetails.accountName)) {
    const maskedAcc = bankDetails.accountNumber ? `•••• ${String(bankDetails.accountNumber).slice(-4)}` : "Registered Bank Account";
    accountDestHtml = `
      <div style="font-size:12px; font-weight:700; color:#0f172a;">${bankDetails.bankName || "Bank Transfer"} (${maskedAcc})</div>
      ${bankDetails.ifscCode ? `<div style="font-size:11px; color:#64748b; font-family:monospace;">IFSC: ${bankDetails.ifscCode}</div>` : ""}
    `;
  } else {
    accountDestHtml = `<div style="font-size:12px; font-weight:700; color:#0f172a;">Registered Merchant Settlement Account</div>`;
  }

  const bodyHtml = `
    <!-- Large Disbursement Banner -->
    <div style="background:linear-gradient(135deg, #064e3b 0%, #047857 60%, #10b981 100%); border-radius:20px; padding:26px; margin-bottom:24px; color:#ffffff; text-align:center;">
      <div style="font-size:11px; font-weight:800; letter-spacing:0.18em; text-transform:uppercase; color:#a7f3d0; margin-bottom:4px;">Disbursement Amount</div>
      <div style="font-size:36px; font-weight:900; color:#ffffff; letter-spacing:-0.02em;">₹${formattedAmount}</div>
      <div style="font-size:12px; color:#d1fae5; font-weight:600; margin-top:4px;">✅ Successfully Processed by SmartOdisha Finance</div>
    </div>

    <!-- Payout Breakdown Details -->
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:18px; padding:22px; margin-bottom:24px;">
      <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#64748b; margin-bottom:14px; border-bottom:1px solid #f1f5f9; padding-bottom:8px;">Payout Breakdown & Transfer Details</div>
      
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#64748b; font-weight:600;">Transaction / UTR Reference</td>
          <td align="right" style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:13px; color:#0f172a; font-weight:800; font-family:monospace;">
            ${referenceId ? referenceId : "Direct Settlement"}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#64748b; font-weight:600;">Disbursement Date</td>
          <td align="right" style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#0f172a; font-weight:700;">
            ${dateStr}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#64748b; font-weight:600;">Settlement Destination</td>
          <td align="right" style="padding:8px 0; border-bottom:1px solid #f8fafc;">
            ${accountDestHtml}
          </td>
        </tr>
        ${note ? `
        <tr>
          <td style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#64748b; font-weight:600;">Admin Remarks / Note</td>
          <td align="right" style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#0f172a; font-weight:600; max-width:260px;">
            ${note}
          </td>
        </tr>
        ` : ""}
      </table>
    </div>

    <!-- Wallet Balance Status After Payout -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
      <tr>
        <td width="50%" style="padding-right:8px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:16px; text-align:center;">
            <div style="font-size:10px; font-weight:800; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Remaining Pending Wallet</div>
            <div style="font-size:18px; font-weight:900; color:#0f172a; margin-top:4px;">₹${formattedPending}</div>
          </div>
        </td>
        <td width="50%" style="padding-left:8px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:16px; padding:16px; text-align:center;">
            <div style="font-size:10px; font-weight:800; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Total Disbursed to Date</div>
            <div style="font-size:18px; font-weight:900; color:#16a34a; margin-top:4px;">₹${formattedTotalPaid}</div>
          </div>
        </td>
      </tr>
    </table>

    <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:16px; padding:14px 18px; font-size:12px; color:#166534; line-height:1.6;">
      ℹ️ <strong>Settlement Clearing Notice:</strong> The transfer has been authorized by our finance desk. For IMPS/UPI transfers, funds usually reflect instantly. For NEFT/RTGS, please allow 2 to 24 bank working hours.
    </div>
  `;

  const html = buildEmailWrapper({
    previewText: `SmartOdisha Payout Processed: ₹${formattedAmount} disbursed to your seller account.`,
    badgeText: "PAYOUT DISBURSED 💰",
    badgeColor: "#16a34a",
    badgeBg: "#f0fdf4",
    heading: `Payout Initiated: ₹${formattedAmount}`,
    subheading: `Hi ${sellerName}, your vendor payout has been released. Full breakdown below.`,
    bodyHtml,
    ctaText: "View Earnings & Statements 📊",
    ctaUrl: `${FRONTEND_URL}/business/wallet`
  });

  return sendEmail({ to: sellerEmail, subject, html });
};

/**
 * 10. Seller Wallet Deduction Alert Email
 */
export const sendSellerWalletDeductionEmail = async ({
  sellerEmail,
  sellerName = "Seller Partner",
  amount,
  note = "",
  remainingPending = 0,
  proofImage = "",
  transactionId = ""
}) => {
  if (!sellerEmail) return;

  const formattedAmount = Number(amount || 0).toLocaleString("en-IN");
  const formattedPending = Number(remainingPending || 0).toLocaleString("en-IN");
  const dateStr = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  const subject = `⚠️ Notice: Wallet Deduction of ₹${formattedAmount} Applied - ${COMPANY_NAME}`;

  const bodyHtml = `
    <!-- Deduction Alert Card -->
    <div style="background:linear-gradient(135deg, #7f1d1d 0%, #991b1b 60%, #b91c1c 100%); border-radius:20px; padding:26px; margin-bottom:24px; color:#ffffff; text-align:center;">
      <div style="font-size:11px; font-weight:800; letter-spacing:0.18em; text-transform:uppercase; color:#fca5a5; margin-bottom:4px;">Deduction / Adjustment</div>
      <div style="font-size:36px; font-weight:900; color:#ffffff; letter-spacing:-0.02em;">-₹${formattedAmount}</div>
      <div style="font-size:12px; color:#fecaca; font-weight:600; margin-top:4px;">Adjusted from your Pending Wallet Balance</div>
    </div>

    <!-- Reason & Deduction Audit Details -->
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:18px; padding:22px; margin-bottom:24px;">
      <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#64748b; margin-bottom:14px; border-bottom:1px solid #f1f5f9; padding-bottom:8px;">Adjustment Breakdown</div>
      
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#64748b; font-weight:600;">Reason / Remark</td>
          <td align="right" style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:13px; color:#991b1b; font-weight:800;">
            ${note || "Admin Adjustment / Return Fee / Penalty"}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#64748b; font-weight:600;">Adjustment Date</td>
          <td align="right" style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#0f172a; font-weight:700;">
            ${dateStr}
          </td>
        </tr>
        ${transactionId ? `
        <tr>
          <td style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#64748b; font-weight:600;">Audit Transaction ID</td>
          <td align="right" style="padding:8px 0; border-bottom:1px solid #f8fafc; font-size:12px; color:#0f172a; font-family:monospace; font-weight:700;">
            ${transactionId}
          </td>
        </tr>
        ` : ""}
        <tr>
          <td style="padding:8px 0; font-size:12px; color:#64748b; font-weight:600;">Updated Pending Balance</td>
          <td align="right" style="padding:8px 0; font-size:14px; color:#0f172a; font-weight:900;">
            ₹${formattedPending}
          </td>
        </tr>
      </table>

      ${proofImage ? `
        <div style="margin-top:16px; padding-top:16px; border-top:1px solid #f1f5f9;">
          <div style="font-size:11px; font-weight:800; color:#64748b; text-transform:uppercase; margin-bottom:8px;">Attached Documentation:</div>
          <a href="${proofImage}" target="_blank" style="display:inline-block; border-radius:10px; overflow:hidden; border:1px solid #e2e8f0; text-decoration:none;">
            <img src="${proofImage}" alt="Deduction Proof" style="max-height:160px; max-width:100%; object-fit:cover; display:block;" />
            <div style="padding:6px 10px; background:#f8fafc; font-size:11px; font-weight:700; color:#4f46e5; text-align:center;">Click to inspect proof document ↗</div>
          </a>
        </div>
      ` : ""}
    </div>

    <!-- Dispute / Help Notice -->
    <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:16px; padding:16px; font-size:12px; color:#991b1b; line-height:1.6;">
      ⚖️ <strong>Dispute or Inquiry:</strong> If you believe this deduction was made in error or requires clarification, please raise a ticket directly through your <strong>Seller Support Center</strong> or reply to your merchant manager.
    </div>
  `;

  const html = buildEmailWrapper({
    previewText: `Notice: Wallet adjustment of -₹${formattedAmount} applied to your seller account.`,
    badgeText: "WALLET ADJUSTMENT ⚠️",
    badgeColor: "#dc2626",
    badgeBg: "#fef2f2",
    heading: `Wallet Adjustment: -₹${formattedAmount}`,
    subheading: `Hi ${sellerName}, an adjustment has been made to your pending balance. Details are provided below.`,
    bodyHtml,
    ctaText: "Check Wallet Balance 💼",
    ctaUrl: `${FRONTEND_URL}/business/wallet`
  });

  return sendEmail({ to: sellerEmail, subject, html });
};

/**
 * 11. Seller Order Cancelled Alert Email
 */
export const sendSellerOrderCancelledAlertEmail = async (sellerEmail, sellerName = "Seller Partner", order, reason = "") => {
  if (!sellerEmail || !order) return;

  const orderNum = order.orderNumber || String(order._id).slice(-8).toUpperCase();
  const subject = `🚫 Cancelled: Order #${orderNum} Has Been Cancelled - Do Not Dispatch`;

  const itemsRows = (order.items || []).map(it => {
    const productUrl = it.product ? `${FRONTEND_URL}/products/${it.product}` : `${FRONTEND_URL}/business/products`;
    return `
      <tr>
        <td style="padding:8px 0; border-bottom:1px solid #f1f5f9; font-size:13px; font-weight:700; color:#0f172a;">
          <a href="${productUrl}" target="_blank" style="color:#0f172a; text-decoration:none; font-weight:700;">${it.name}</a>
        </td>
        <td align="center" style="padding:8px 0; border-bottom:1px solid #f1f5f9; font-size:13px; font-weight:800; color:#991b1b;">
          ${it.quantity}
        </td>
      </tr>
    `;
  }).join("");

  const bodyHtml = `
    <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:18px; padding:20px; margin-bottom:24px;">
      <div style="font-size:14px; font-weight:800; color:#991b1b; margin-bottom:4px;">Notice: Order Cancelled</div>
      <div style="font-size:13px; color:#7f1d1d; line-height:1.5;">
        Order <strong>#${orderNum}</strong> has been cancelled. 
        <br/><br/>
        ⚠️ <strong>Do NOT pack or hand over this parcel to the Delhivery courier executive.</strong>
      </div>
      ${reason ? `
        <div style="margin-top:12px; padding-top:12px; border-top:1px solid #fee2e2; font-size:12px; color:#991b1b;">
          <strong>Reason:</strong> ${reason}
        </div>
      ` : ""}
    </div>

    <!-- Items List -->
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:18px; padding:18px 20px; margin-bottom:24px;">
      <div style="font-size:11px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#64748b; margin-bottom:10px;">Cancelled Order Items (Stock Restored):</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${itemsRows}
      </table>
    </div>

    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:14px; font-size:12px; color:#64748b;">
      ✅ The stock for these items has been automatically restored to your active inventory.
    </div>
  `;

  const html = buildEmailWrapper({
    previewText: `Order #${orderNum} has been cancelled. Please do not dispatch this package.`,
    badgeText: "ORDER CANCELLED 🚫",
    badgeColor: "#dc2626",
    badgeBg: "#fef2f2",
    heading: `Order #${orderNum} Cancelled`,
    subheading: `Hi ${sellerName}, please halt packaging and dispatch for this order.`,
    bodyHtml,
    ctaText: "Open Seller Orders 📦",
    ctaUrl: `${FRONTEND_URL}/business/orders`
  });

  return sendEmail({ to: sellerEmail, subject, html });
};
