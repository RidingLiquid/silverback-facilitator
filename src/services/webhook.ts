/**
 * Webhook Service
 *
 * Sends notifications to registered webhooks when settlements complete.
 * Fire-and-forget delivery with optional HMAC signing.
 */

import * as crypto from 'crypto';
import { getWebhooksForEvent, WebhookRecord } from './database';

// ============================================================================
// Types
// ============================================================================

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: {
    transactionId: string;
    txHash?: string;
    payer: string;
    receiver: string;
    token: string;
    amount: string;
    fee: string;
    network: string;
    status: 'success' | 'failed';
    errorReason?: string;
  };
}

// ============================================================================
// Webhook Delivery
// ============================================================================

/**
 * Send webhook notification (fire-and-forget)
 */
export async function sendWebhook(
  event: string,
  data: WebhookPayload['data']
): Promise<void> {
  try {
    const webhooks = await getWebhooksForEvent(event);

    if (webhooks.length === 0) {
      return;
    }

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    // Fire-and-forget: don't await
    for (const webhook of webhooks) {
      deliverWebhook(webhook, payload).catch((err) => {
        console.error(`[Webhook] Failed to deliver to ${webhook.url}:`, err.message);
      });
    }
  } catch (error) {
    console.error('[Webhook] Error sending webhooks:', error);
  }
}

/**
 * Deliver webhook to a single endpoint
 */
async function deliverWebhook(
  webhook: WebhookRecord,
  payload: WebhookPayload
): Promise<void> {
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Silverback-Facilitator/1.0',
    'X-Webhook-Event': payload.event,
    'X-Webhook-Timestamp': payload.timestamp,
  };

  // Add HMAC signature if secret is configured
  if (webhook.secret) {
    const signature = computeSignature(body, webhook.secret);
    headers['X-Webhook-Signature'] = signature;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[Webhook] ${webhook.url} returned ${response.status}`);
    } else {
      console.log(`[Webhook] Delivered ${payload.event} to ${webhook.url}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compute HMAC-SHA256 signature
 */
function computeSignature(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

// ============================================================================
// Settlement Event Helpers
// ============================================================================

/**
 * Send settlement success webhook
 */
export async function notifySettlementSuccess(data: {
  transactionId: string;
  txHash: string;
  payer: string;
  receiver: string;
  token: string;
  amount: string;
  fee: string;
  network: string;
}): Promise<void> {
  await sendWebhook('settlement.success', {
    ...data,
    status: 'success',
  });
}

/**
 * Send settlement failed webhook
 */
export async function notifySettlementFailed(data: {
  transactionId: string;
  payer: string;
  receiver: string;
  token: string;
  amount: string;
  fee: string;
  network: string;
  errorReason: string;
}): Promise<void> {
  await sendWebhook('settlement.failed', {
    ...data,
    status: 'failed',
  });
}
