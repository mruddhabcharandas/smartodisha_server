import { sendMail } from "./mail.js";

export const sendLowStockEmail = async (items, threshold) => {
  const to = process.env.MAIL_TO || process.env.MAIL_FROM;
  if (!to) return { sent: false, reason: "no_recipient" };
  const subject = `Low stock alert (${items.length})`;
  const lines = items.map((p) => `- ${p.name} (stock ${p.stock})`).join("\n");
  const text = `The following items are at or below the threshold (${threshold}):\n\n${lines}`;
  return sendMail({ to, subject, text });
};

