import { sendEmail, CENTRALIZED_SENDER } from "./mailer.js";

export { CENTRALIZED_SENDER };

export const sendMail = async ({ to, subject, text, html, from }) => {
  try {
    await sendEmail({ to, subject, text, html, from: from || CENTRALIZED_SENDER.formatted });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err?.message || "mail_failed" };
  }
};

