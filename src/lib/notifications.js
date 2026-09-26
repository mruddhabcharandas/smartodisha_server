import { sendMail } from "./mail.js";
import { renderMail, CENTRALIZED_SENDER } from "./mailer.js";

export const sendLowStockEmail = async (items, threshold) => {
  const to = process.env.MAIL_TO || process.env.MAIL_FROM;
  if (!to) return { sent: false, reason: "no_recipient" };
  const subject = `Low Stock Alert (${items.length} Products) - SmartOdisha`;
  const frontendUrl = process.env.FRONTEND_URL || "https://smartodisha.in";

  const blocks = items.slice(0, 15).map(p => ({
    label: p.name,
    value: `Stock: ${p.stock}`
  }));

  const html = renderMail({
    heading: `⚠️ Low Stock Alert (${items.length} Products)`,
    subheading: `The following inventory items are at or below the minimum stock threshold of ${threshold} units.`,
    blocks,
    ctaText: "Open Admin Dashboard 📊",
    ctaUrl: `${frontendUrl}/admin`
  });

  return sendMail({ to, subject, html, from: CENTRALIZED_SENDER.formatted });
};


