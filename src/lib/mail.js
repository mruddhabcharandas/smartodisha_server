import { sendEmail } from "./mailer.js";

export const sendMail = async ({ to, subject, text, html }) => {
  try {
    await sendEmail({ to, subject, text, html });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err?.message || "mail_failed" };
  }
};
