import axios from "axios";
  
async function getAccessToken() {
  const res = await axios.post("https://accounts.zoho.in/oauth/v2/token", null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: "refresh_token"
    }
  });
  return res.data.access_token;
}

export const sendEmail = async ({ to, subject, text, html }) => {
  const content = html || (text ? `<pre>${text}</pre>` : "");
  try {
    const accessToken = await getAccessToken();
    await axios.post(
      `https://mail.zoho.in/api/accounts/${process.env.ZOHO_ACCOUNT_ID}/messages`,
      {
        fromAddress: `${process.env.MAIL_FROM_NAME || process.env.COMPANY_NAME || "SmartOdisha"} <${process.env.ZOHO_MAIL_FROM}>`,
        toAddress: to,
        subject,
        content
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`
        }
      }
    );
    return { sent: true };
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error("Email sending failed:", detail);
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
};

const COMPANY_NAME = process.env.COMPANY_NAME || "SmartOdisha";
const LOGO_URL = process.env.LOGO_URL || "https://smartodisha.in/logo.png";
const BRAND_COLOR = "#0f172a"; // Dark blue/black
const ACCENT_COLOR = "#7c3aed"; // Violet/Purple

export const renderMail = ({ heading, subheading, blocks, highlight, items, totals }) => {
  const year = new Date().getFullYear();
  const h = highlight ? `<div style="margin:24px 0;padding:20px;border:1px solid #e9d5ff;border-radius:16px;background:#f5f3ff;font-weight:800;color:${ACCENT_COLOR};text-align:center;font-size:18px;letter-spacing:0.02em">${highlight}</div>` : "";
  const b = (blocks || []).map(({ label, value }) => `
    <div style="display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #f1f5f9">
      <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:.1em;text-transform:uppercase">${label}</div>
      <div style="font-size:14px;color:#1e293b;font-weight:700;text-align:right">${value}</div>
    </div>
  `).join("");
  const irows = Array.isArray(items) && items.length
    ? `
      <div style="margin-top:32px;border:1px solid #f1f5f9;border-radius:16px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.02)">
        <div style="display:flex;background:#f8fafc;border-bottom:1px solid #f1f5f9">
          <div style="flex:6;padding:14px 16px;font-size:10px;color:#64748b;font-weight:800;letter-spacing:.1em;text-transform:uppercase">Product</div>
          <div style="flex:2;padding:14px 16px;font-size:10px;color:#64748b;font-weight:800;letter-spacing:.1em;text-transform:uppercase;text-align:right">Qty</div>
          <div style="flex:4;padding:14px 16px;font-size:10px;color:#64748b;font-weight:800;letter-spacing:.1em;text-transform:uppercase;text-align:right">Total</div>
        </div>
        ${items.map(it => `
          <div style="display:flex;border-top:1px solid #f1f5f9;background:#ffffff">
            <div style="flex:6;padding:14px 16px;font-size:13px;color:#1e293b;font-weight:600">${it.name}</div>
            <div style="flex:2;padding:14px 16px;font-size:13px;color:#1e293b;text-align:right;font-weight:700">${it.quantity}</div>
            <div style="flex:4;padding:14px 16px;font-size:13px;color:#1e293b;text-align:right;font-weight:700">₹${Number(it.lineTotal || (it.price * it.quantity)).toLocaleString("en-IN")}</div>
          </div>
        `).join("")}
        ${totals ? `
          <div style="border-top:2px solid #f1f5f9;background:#fcfcfc;padding:16px">
            <div style="display:flex;justify-content:flex-end;margin-bottom:8px;gap:32px">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:.05em;text-transform:uppercase">Subtotal</div>
              <div style="font-size:14px;color:#475569;font-weight:700">₹${Number(totals.subtotal || 0).toLocaleString("en-IN")}</div>
            </div>
            ${totals.discount ? `
            <div style="display:flex;justify-content:flex-end;margin-bottom:8px;gap:32px">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:.05em;text-transform:uppercase">Discount</div>
              <div style="font-size:14px;color:#10b981;font-weight:700">-₹${Number(totals.discount || 0).toLocaleString("en-IN")}</div>
            </div>
            ` : ""}
            <div style="display:flex;justify-content:flex-end;margin-bottom:12px;gap:32px">
              <div style="font-size:11px;color:#94a3b8;font-weight:700;letter-spacing:.05em;text-transform:uppercase">Tax (GST)</div>
              <div style="font-size:14px;color:#475569;font-weight:700">₹${Number(totals.gstTotal || 0).toLocaleString("en-IN")}</div>
            </div>
            <div style="display:flex;justify-content:flex-end;padding-top:12px;border-top:1px solid #f1f5f9;gap:32px">
              <div style="font-size:12px;color:#1e293b;font-weight:800;letter-spacing:.05em;text-transform:uppercase">Grand Total</div>
              <div style="font-size:20px;color:${ACCENT_COLOR};font-weight:900">₹${Number(totals.total || 0).toLocaleString("en-IN")}</div>
            </div>
          </div>
        ` : ""}
      </div>
    `
    : "";
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:20px auto;padding:40px;border:1px solid #f1f5f9;border-radius:24px;background:#ffffff;box-shadow:0 20px 40px rgba(0,0,0,0.03)">
      <div style="text-align:center;margin-bottom:32px">
        <img src="${LOGO_URL}" alt="${COMPANY_NAME}" style="height:50px;margin-bottom:16px;">
        <div style="font-size:12px;letter-spacing:.3em;color:${ACCENT_COLOR};background:#f5f3ff;border:1px solid #e9d5ff;display:inline-block;padding:8px 20px;border-radius:100px;font-weight:900;text-transform:uppercase">${COMPANY_NAME}</div>
      </div>
      <h1 style="margin:0 0 12px;font-size:28px;line-height:1.1;color:#0f172a;font-weight:900;text-align:center;letter-spacing:-0.02em">${heading || ""}</h1>
      <div style="margin:0 0 32px;font-size:15px;color:#64748b;text-align:center;line-height:1.6;font-weight:500">${subheading || ""}</div>
      ${h}
      <div style="margin-top:24px;padding:8px 0">${b}</div>
      ${irows}
      <div style="margin-top:40px;padding:24px;background:#f8fafc;border-radius:16px;color:#64748b;font-size:13px;line-height:1.6;text-align:center;border:1px solid #f1f5f9">
        This is a premium automated message from <strong>${COMPANY_NAME}</strong>. 
        <br/>If you have any questions, our support team is here to help.
      </div>
      <div style="margin-top:32px;text-align:center;font-size:12px;color:#cbd5e1;font-weight:600;letter-spacing:0.05em">
        © ${year} ${COMPANY_NAME.toUpperCase()}. ALL RIGHTS RESERVED.
      </div>
    </div>
  `;
};

export const sendOTP = async (email, otp, purpose = "ACCOUNT_VERIFICATION") => {
  const subject =
    purpose === "FORGOT_PASSWORD"
      ? `Reset Your Password - ${COMPANY_NAME}`
      : purpose === "PARTNER_LOGIN"
      ? `Partner Portal Access OTP - ${COMPANY_NAME}`
      : `Email Verification OTP - ${COMPANY_NAME}`;
  
  const title =
    purpose === "FORGOT_PASSWORD" ? "Reset Password" :
    purpose === "PARTNER_LOGIN" ? "Partner Login" : "Verify Email";

  const intro =
    purpose === "FORGOT_PASSWORD" ? "You requested to reset your password. Use the secure code below." :
    purpose === "PARTNER_LOGIN" ? "Use the one-time password below to access your Partner Dashboard." :
    "Use the secure code below to verify your email and complete your setup.";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:500px;margin:20px auto;padding:40px;border:1px solid #f1f5f9;border-radius:24px;background:#ffffff;box-shadow:0 20px 40px rgba(0,0,0,0.03);text-align:center;">
      <div style="text-align:center;margin-bottom:32px">
        <img src="${LOGO_URL}" alt="${COMPANY_NAME}" style="height:40px;margin-bottom:16px;">
        <br>
        <div style="font-size:12px;letter-spacing:.3em;color:${ACCENT_COLOR};background:#f5f3ff;border:1px solid #e9d5ff;display:inline-block;padding:8px 20px;border-radius:100px;font-weight:900;text-transform:uppercase">${COMPANY_NAME}</div>
      </div>
      <h2 style="color:#0f172a;margin:0 0 12px;font-weight:900;font-size:24px;letter-spacing:-0.02em">${title}</h2>
      <p style="color:#64748b;line-height:1.6;font-size:15px;margin-bottom:32px;font-weight:500">${intro}</p>
      <div style="background:${BRAND_COLOR};color:#ffffff;padding:24px;text-align:center;font-size:36px;font-weight:900;letter-spacing:8px;border-radius:20px;box-shadow:0 12px 24px rgba(15,23,42,0.2);margin-bottom:32px">
        ${otp}
      </div>
      <p style="color:#94a3b8;font-size:13px;font-weight:500;margin-bottom:8px">Valid for 10 minutes. Do not share this code.</p>
      <p style="color:#94a3b8;font-size:13px;font-weight:500">If you didn't request this, please ignore this email.</p>
      <hr style="border:none;border-top:1px solid #f1f5f9;margin:32px 0">
      <p style="text-align:center;font-size:12px;color:#cbd5e1;font-weight:600;letter-spacing:0.05em">
        © ${new Date().getFullYear()} ${COMPANY_NAME.toUpperCase()}. ALL RIGHTS RESERVED.
      </p>
    </div>
  `;
  return sendEmail({ to: email, subject, html });
};

export const sendSellerGreeting = async (email, sellerName) => {
  const subject = `Welcome to the ${COMPANY_NAME} Seller Family!`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:20px auto;padding:40px;border:1px solid #f1f5f9;border-radius:24px;background:#ffffff;box-shadow:0 20px 40px rgba(0,0,0,0.03)">
      <div style="text-align:center;margin-bottom:32px">
        <img src="${LOGO_URL}" alt="${COMPANY_NAME}" style="height:50px;margin-bottom:16px;">
        <br>
        <div style="font-size:12px;letter-spacing:.3em;color:${ACCENT_COLOR};background:#f5f3ff;border:1px solid #e9d5ff;display:inline-block;padding:8px 20px;border-radius:100px;font-weight:900;text-transform:uppercase">${COMPANY_NAME}</div>
      </div>
      <h1 style="color:#0f172a;margin:0 0 20px;font-weight:900;font-size:28px;text-align:center">Congratulations, ${sellerName}!</h1>
      <p style="color:#64748b;line-height:1.6;font-size:16px;margin-bottom:24px">
        Your store has been approved and is now live on <strong>${COMPANY_NAME}</strong>. We are thrilled to have you on board!
      </p>
      <div style="background:#f8fafc;padding:24px;border-radius:16px;border:1px solid #f1f5f9;margin-bottom:32px">
        <h3 style="color:#0f172a;margin-top:0">Next Steps:</h3>
        <ul style="color:#475569;padding-left:20px;line-height:1.8">
          <li>Log in to your Seller Dashboard</li>
          <li>Complete your profile and banking details</li>
          <li>Start uploading your products</li>
          <li>Reach out to support if you need help</li>
        </ul>
      </div>
      <div style="text-align:center">
        <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/business/login" style="background:${ACCENT_COLOR};color:#ffffff;padding:16px 32px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;box-shadow:0 8px 16px rgba(124,58,237,0.2)">Go to Dashboard</a>
      </div>
      <hr style="border:none;border-top:1px solid #f1f5f9;margin:40px 0">
      <p style="text-align:center;font-size:12px;color:#cbd5e1;font-weight:600;letter-spacing:0.05em">
        © ${new Date().getFullYear()} ${COMPANY_NAME.toUpperCase()}. ALL RIGHTS RESERVED.
      </p>
    </div>
  `;
  return sendEmail({ to: email, subject, html });
};

export const sendPasswordResetEmail = async (email, name, resetUrl) => {
  const subject = `Reset Your Password - ${COMPANY_NAME}`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:20px auto;padding:40px;border:1px solid #f1f5f9;border-radius:24px;background:#ffffff;box-shadow:0 20px 40px rgba(0,0,0,0.03)">
      <div style="text-align:center;margin-bottom:32px">
        <img src="${LOGO_URL}" alt="${COMPANY_NAME}" style="height:40px;margin-bottom:16px;">
        <br>
        <div style="font-size:12px;letter-spacing:.3em;color:${ACCENT_COLOR};background:#f5f3ff;border:1px solid #e9d5ff;display:inline-block;padding:8px 20px;border-radius:100px;font-weight:900;text-transform:uppercase">${COMPANY_NAME}</div>
      </div>
      <h2 style="color:#0f172a;margin:0 0 20px;font-weight:900;font-size:24px;text-align:center">Password Reset Request</h2>
      <p style="color:#64748b;line-height:1.6;font-size:16px;margin-bottom:24px">
        Hi ${name},<br><br>
        We received a request to reset your password. If you didn't make this request, you can safely ignore this email.
      </p>
      <div style="text-align:center;margin:32px 0">
        <a href="${resetUrl}" style="background:${BRAND_COLOR};color:#ffffff;padding:16px 32px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block">Reset Password</a>
      </div>
      <p style="color:#94a3b8;font-size:13px;text-align:center">
        This link will expire in 1 hour.
      </p>
      <hr style="border:none;border-top:1px solid #f1f5f9;margin:40px 0">
      <p style="text-align:center;font-size:12px;color:#cbd5e1;font-weight:600;letter-spacing:0.05em">
        © ${new Date().getFullYear()} ${COMPANY_NAME.toUpperCase()}. ALL RIGHTS RESERVED.
      </p>
    </div>
  `;
  return sendEmail({ to: email, subject, html });
};
