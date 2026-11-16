/**
 * Client communications adapter: residents, via Wave (ATEC's client and ticketing system).
 * Contract: docs/WAVE_INTEGRATION.md
 *
 *   POST {CLIENT_API_URL}/api/outage-notices   (Bearer CLIENT_API_TOKEN, Idempotency-Key = delivery id)
 *   → 202 { id }   Wave sends SMS + email + portal notice to every active client at the estate.
 *
 * address "list:<estate>"  = everyone at that estate (the site's Residents list reference)
 * address "account:<code>" = one client account only (resident Test mode)
 *
 * Delivery results come back through /api/webhooks/delivery/client-api (HMAC signed).
 */
import { DeliveryError, type DeliveryAdapter, type OutboundMessage, type SendResult } from "./types";

/** CLIENT_API_URL may be Wave's base URL or the full endpoint URL. */
export function waveUrl(path: string) {
  const base = (process.env.CLIENT_API_URL ?? "").replace(/\/+$/, "");
  return base.endsWith("/api/outage-notices") ? base.replace(/\/api\/outage-notices$/, path) : `${base}${path}`;
}

/** SMS uses the approved subject line (it already names the estate, the update and the reference). */
export function smsText(subject: string) {
  const t = subject.replace(/\s+/g, " ").trim();
  return t.length <= 300 ? t : `${t.slice(0, 297)}...`;
}

export const clientApiAdapter: DeliveryAdapter = {
  channel: "client_api",
  isCapture: false,
  configError() {
    if (!process.env.CLIENT_API_URL) return "CLIENT_API_URL is not set";
    if (!process.env.CLIENT_API_TOKEN) return "CLIENT_API_TOKEN is not set";
    return null;
  },
  async send(msg: OutboundMessage): Promise<SendResult> {
    // list:<ref> = a site's resident distribution list; account:<code> = one client account (test mode).
    const isAccount = msg.address.startsWith("account:");
    const ref = msg.address.replace(/^(list|account):/, "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(process.env.CLIENT_API_TIMEOUT_MS ?? 15000));
    let res: Response;
    try {
      res = await fetch(waveUrl("/api/outage-notices"), {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.CLIENT_API_TOKEN}`,
          "idempotency-key": msg.deliveryId,
        },
        body: JSON.stringify({
          delivery_id: msg.deliveryId,
          incident_reference: msg.meta.incidentReference,
          ...(isAccount ? { account_code: ref, estate: null } : { estate: ref, account_code: null }),
          network: msg.meta.network || null,
          kind: msg.meta.kind,
          notice_status: msg.meta.purpose === "restoration" || msg.meta.purpose === "final" ? "resolved" : "open",
          channels: ["sms", "email", "portal"],
          subject: isAccount ? `[TEST] ${msg.subject}` : msg.subject,
          text: msg.text,
          html: msg.html,
          sms_text: smsText(isAccount ? `[TEST] ${msg.subject}` : msg.subject),
          site_code: msg.meta.siteCode,
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
