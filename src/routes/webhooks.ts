/**
 * Webhook Management Routes
 *
 * Endpoints for registering and managing webhooks.
 */

import { Router, Request, Response } from 'express';
import {
  registerWebhook,
  listWebhooks,
  deactivateWebhook,
} from '../services/database';

const router = Router();

/**
 * POST /webhooks
 *
 * Register a new webhook
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { url, events, secret } = req.body;

    if (!url) {
      return res.status(400).json({
        error: 'Missing url',
      });
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        error: 'Invalid URL format',
      });
    }

    // Validate events
    const validEvents = ['settlement.success', 'settlement.failed'];
    const webhookEvents = events || validEvents;
    for (const event of webhookEvents) {
      if (!validEvents.includes(event)) {
        return res.status(400).json({
          error: `Invalid event: ${event}. Valid events: ${validEvents.join(', ')}`,
        });
      }
    }

    const id = await registerWebhook(url, webhookEvents, secret);

    res.status(201).json({
      id,
      url,
      events: webhookEvents,
      hasSecret: !!secret,
      active: true,
    });
  } catch (error) {
    console.error('[Webhooks] Registration error:', error);
    res.status(500).json({
      error: 'Failed to register webhook',
    });
  }
});

/**
 * GET /webhooks
 *
 * List all webhooks
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const webhooks = await listWebhooks();

    // Don't expose secrets
    const sanitized = webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      hasSecret: !!w.secret,
      active: w.active,
      created_at: w.created_at,
    }));

    res.json({ webhooks: sanitized });
  } catch (error) {
    console.error('[Webhooks] List error:', error);
    res.status(500).json({
      error: 'Failed to list webhooks',
    });
  }
});

/**
 * DELETE /webhooks/:id
 *
 * Deactivate a webhook
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await deactivateWebhook(id);

    res.json({
      id,
      active: false,
    });
  } catch (error) {
    console.error('[Webhooks] Deactivate error:', error);
    res.status(500).json({
      error: 'Failed to deactivate webhook',
    });
  }
});

export default router;
