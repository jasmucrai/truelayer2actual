import axios from 'axios';
import { getConnection, saveConnection, type Tokens } from './auth/tokens.js';
import { withStateLock } from './util/lock.js';
import { HTTP_TIMEOUT_MS } from './util/http.js';
import { logger } from './logger.js';

export interface NotifyOptions {
  title: string;
  message: string;
  priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
  url?: string;
}

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Send a notification to every configured backend. Resolves `true` if at least
 * one delivery succeeded (or none are configured), `false` if all failed.
 * Never throws: a failed notification must not break sync.
 */
export async function notify(options: NotifyOptions): Promise<boolean> {
  const tasks: Promise<unknown>[] = [];

  const ntfyUrl = process.env.NTFY_URL;
  if (ntfyUrl) {
    const body = new URLSearchParams({ title: options.title, message: options.message });
    if (options.priority) body.set('priority', options.priority);
    if (options.url) body.set('click', options.url);
    tasks.push(
      axios.post(ntfyUrl, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: HTTP_TIMEOUT_MS,
      })
    );
  }

  const haWebhookUrl = process.env.HA_WEBHOOK_URL;
  if (haWebhookUrl) {
    tasks.push(
      axios.post(
        haWebhookUrl,
        {
          title: options.title,
          message: options.message,
          url: options.url,
        },
        { timeout: HTTP_TIMEOUT_MS }
      )
    );
  }

  if (tasks.length === 0) return true;

  const results = await Promise.allSettled(tasks);
  let delivered = 0;
  for (const result of results) {
    if (result.status === 'rejected') {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.warn('Notification delivery failed:', reason);
    } else {
      delivered++;
    }
  }
  return delivered > 0;
}

/**
 * Send a notification for a connection at most once per 24h *per reason*,
 * recording the time/reason in tokens.json so restarts don't cause a
 * notification storm and a more urgent reason isn't suppressed by a milder one.
 *
 * The dedupe marker is written under the state lock as a claim, then released
 * if every delivery attempt fails so the next sync retries. Delivery itself is
 * fire-and-forget so a slow endpoint can never block sync.
 */
export async function notifyConnection(
  connectionId: string,
  reason: string,
  options: NotifyOptions
): Promise<void> {
  try {
    let shouldSend = false;
    await withStateLock(async () => {
      const current = getConnection(connectionId);
      if (!current) return;
      const last = current.lastNotifiedAt ? Date.parse(current.lastNotifiedAt) : NaN;
      const sameReason = current.lastNotifiedReason === reason;
      if (Number.isFinite(last) && Date.now() - last < DEDUPE_WINDOW_MS && sameReason) {
        logger.debug(`[${connectionId}] Suppressing duplicate ${reason} notification`);
        return;
      }
      const marked: Tokens = {
        ...current,
        lastNotifiedAt: new Date().toISOString(),
        lastNotifiedReason: reason,
      };
      saveConnection(connectionId, marked);
      shouldSend = true;
    });

    if (shouldSend) {
      void notify(options)
        .then((delivered) => {
          if (delivered) return;
          // Every backend failed — release the dedupe marker so the next
          // sync run tries again instead of staying quiet for 24h.
          return withStateLock(async () => {
            const current = getConnection(connectionId);
            if (!current || current.lastNotifiedReason !== reason) return;
            const last = current.lastNotifiedAt ? Date.parse(current.lastNotifiedAt) : NaN;
            if (!Number.isFinite(last) || Date.now() - last >= DEDUPE_WINDOW_MS) return;
            saveConnection(connectionId, {
              ...current,
              lastNotifiedAt: undefined,
              lastNotifiedReason: undefined,
            });
          });
        })
        .catch((err) => {
          logger.warn(
            `[${connectionId}] Notification failed:`,
            err instanceof Error ? err.message : String(err)
          );
        });
    }
  } catch (err) {
    logger.warn(
      `[${connectionId}] Notification failed:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
