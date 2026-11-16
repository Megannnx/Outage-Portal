# Integrations — what must be configured before go-live

| Integration | Status in code | What ATEC must provide |
|---|---|---|
| NetXMS → portal | Implemented, tested with simulated events | Server action + EPP rule + token (see `NETXMS_SETUP.md`) |
| Client-base communications API (residents) | **Adapter implemented to a documented contract; real API not yet known** | API URL, auth, payload shape, status callbacks. Adjust `src/server/comms/adapters/client-api.ts` if it differs. |
| SMTP relay (ISPs + internal) | Implemented (nodemailer) | Host, port, credentials, sender domain with SPF/DKIM/DMARC |
| Bounce mailbox (SMTP delivery status) | Implemented (`scripts/bounce-processor.ts`) | IMAP mailbox receiving bounces for `SMTP_FROM` |
| Telegram backup | Implemented | Optional bot + private channel |
| Work-order / ticketing system | **Not integrated** — internal dispatch with acknowledgement link & escalation | If you want tickets created automatically, name the system (and API) |
| AI cross-check | Implemented, optional | `ANTHROPIC_API_KEY` (portal works fully without it) |

Until each is configured, keep `DELIVERY_MODE=capture`. In capture mode a red banner is shown on every page and nothing leaves the system; integrations are never reported as healthy.

## Client communications API (residents)

Each site has a **resident distribution reference** (`Admin › Sites › Residents list`). One message per site is sent to that reference; the client system fans it out to that site's residents.

Request the portal sends:

```http
POST {CLIENT_API_URL}
Authorization: Bearer {CLIENT_API_TOKEN}
Idempotency-Key: {delivery uuid}          ← same key on every retry
Content-Type: application/json

{
  "distribution_ref": "dwv-residents",
  "subject": "Network interruption – Dowerview Estate [INC-2026-000123]",
  "text": "Dear Client, …",
  "html": "<div>…</div>",
  "incident_reference": "INC-2026-000123",
  "site_code": "DWV",
  "delivery_id": "0b9e0e3c-…",
  "callback_url": "https://outages.atec.co.za/api/webhooks/delivery/client-api"
}
```

Response handling: `2xx` → accepted (store `id`/`message_id` if returned). `408`, `429`, `5xx`, timeouts → retried with backoff. Other `4xx` → permanent failure, alerted.

Status callback (optional but recommended):

```http
POST /api/webhooks/delivery/client-api
X-Signature: sha256=<hex HMAC-SHA256 of raw body with CLIENT_API_WEBHOOK_SECRET>
{ "delivery_id": "0b9e0e3c-…", "status": "delivered|bounced|deferred|failed", "detail": "…", "hard": true }
```

## SMTP (ISPs and internal)

* Every ISP contact receives an **individual** message (no shared To/CC/BCC), so ISPs never see each other's addresses.
* Message-ID is `<delivery-uuid@SMTP_MESSAGE_ID_DOMAIN>` — used to match bounces, and stable across retries.
* Internal notifications use the subject prefix `[INTERNAL]` and a separate code path; they never use customer templates or recipient lists.
* Configure SPF, DKIM and DMARC for the sending domain, otherwise ISP NOCs will spam-folder outage notices.

### Bounces

Run the processor (compose profile `bounces`) against the mailbox that receives bounces. It reads unseen messages, matches our Message-ID, classifies DSN status (5.x.x hard, 4.x.x deferred) and posts to `/api/webhooks/delivery/smtp` (bearer `BOUNCE_WEBHOOK_TOKEN`). Non-portal mail is left unread. After `bounceInvalidThreshold` hard bounces a contact is marked invalid and a critical alert lists the ISP that is no longer receiving notices.

## Generic monitoring source (future systems)

```http
POST /api/ingest/generic/{source}         (source: a-z, 0-9, _ or -)
Authorization: Bearer {INGEST_TOKEN_GENERIC}
{ "event_id": "optional-unique-id", "object_id": "router-17", "object_name": "DWV L3GR10",
  "state": "down|up|heartbeat", "occurred_at": "2026-11-16T08:00:00+02:00" }
```

Add identifiers with that `source` (or "Any" for name matches).

## Technician dispatch / ticketing

The portal creates an internal **URGENT** work order with all required fields, emails the site's technical team mailbox and Technical users, and includes a one-tap acknowledgement link (`/dispatch/<token>`, no login, capability token stored only as a hash). It tracks *logged → team notified → acknowledged → on site → completed* and escalates if not acknowledged. If a dispatch is also logged in another system, its number can be recorded on the dispatch. Automatic ticket creation in an external system needs that system's API — not implemented.


## Residents: Wave

Resident messages go through Wave (SMS, email and portal notice per estate). The full contract is in [WAVE_INTEGRATION.md](WAVE_INTEGRATION.md). Each site's Wave estate is its *Residents list reference*, or its estate name when that field is blank. Resident sending is controlled by the safety lock in Admin › Settings (Off / Test / Live).
