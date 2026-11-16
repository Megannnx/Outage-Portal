/**
 * Client communications API adapter — residents/clients.
 *
 * ATEC's client-base system is reached over HTTPS. The exact API is not yet
 * known, so this adapter speaks a small, documented contract (docs/INTEGRATIONS.md):
 *
 *   POST {CLIENT_API_URL}
 *   Authorization: Bearer {CLIENT_API_TOKEN}
 *   Idempotency-Key: {deliveryId}
 *   { distribution_ref, subject, text, html, incident_reference, site_code, callback_url }
 *   → 2xx { id }   (message accepted for the residents on that distribution list)
 *
 * If the real API differs, only this file changes. Delivery status callbacks come
 * back through /api/webhooks/delivery/client-api (HMAC signed).
 */
import { DeliveryError, type DeliveryAdapter, type OutboundMessage, type SendResult } from "./types";

export const clientApiAdapter: DeliveryAdapter = {
  channel: "client_api",
  isCapture: false,
  configError() {
    if (!process.env.CLIENT_API_URL) return "CLIENT_API_URL is not set";
    if (!process.env.CLIENT_API_TOKEN) return "CLIENT_API_TOKEN is not set";
    return null;
  },
  async send(msg: OutboundMessage): Promise<SendResult> {
    const ref = msg.address.startsWith("list:") ? msg.address.slice(5) : msg.address;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(process.env.CLIENT_API_TIMEOUT_MS ?? 15000));
    let res: Response;
    try {
      res = await fetch(process.env.CLIENT_API_URL!, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.CLIENT_API_TOKEN}`,
          "idempotency-key": msg.deliveryId,
        },
        body: JSON.stringify({
          distribution_ref: ref,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
          incident_reference: msg.meta.incidentReference,
          site_code: msg.meta.siteCode,
          delivery_id: msg.deliveryId,
          callback_url: process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL}/api/webhooks/delivery/client-api` : undefined,
        }),
      });
    } catch (e) {
      throw new DeliveryError(`Client API unreachable: ${(e as Error).message}`, true, "network");
    } finally {
      clearTimeout(timer);
    }
    const body = await res.text();
    if (res.ok) {
      let id: string | undefined;
      try { const j = JSON.parse(body); id = j.id ?? j.message_id ?? j.messageId; } catch { /* non-JSON ok */ }
      return { status: "accepted", providerMessageId: id ?? `client-api:${msg.deliveryId}` };
    }
    const transient = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new DeliveryError(`Client API ${res.status}: ${body.slice(0, 300)}`, transient, `http_${res.status}`);
  },
};
