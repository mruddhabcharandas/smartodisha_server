import axios from 'axios';
import SystemSetting from '../models/SystemSetting.js';

/**
 * Triggers an external webhook notification for Support Ticket events.
 * @param {string} event - e.g. 'TICKET_CREATED', 'USER_MESSAGE', 'ADMIN_REPLY', 'MEDIA_REQUEST_CREATED', 'MEDIA_UPLOADED', 'STATUS_UPDATED'
 * @param {object} payload - ticket or event data
 */
export async function triggerSupportWebhook(event, payload) {
  try {
    let webhookUrl = process.env.SUPPORT_WEBHOOK_URL || '';

    // Check database settings if env not configured
    if (!webhookUrl) {
      try {
        const settings = await SystemSetting.findOne().lean();
        if (settings?.supportWebhookUrl) {
          webhookUrl = settings.supportWebhookUrl;
        }
      } catch (dbErr) {
        // Continue silently if DB fetch fails
      }
    }

    if (!webhookUrl || !webhookUrl.trim().startsWith('http')) {
      return; // No webhook configured
    }

    const body = {
      event,
      timestamp: new Date().toISOString(),
      data: payload
    };

    // Fire and catch asynchronously so external endpoint latency/failure never blocks API
    axios.post(webhookUrl.trim(), body, {
      timeout: 6000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SmartOdisha-Support-Webhook/1.0'
      }
    }).catch(err => {
      console.warn(`[SupportWebhook] Dispatch failed to ${webhookUrl}:`, err.message);
    });
  } catch (err) {
    console.warn('[SupportWebhook] Error triggering webhook:', err.message);
  }
}
