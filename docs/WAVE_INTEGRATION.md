# Wave ↔ Outage Portal integration brief

**For:** the team (or Claude session) that builds and maintains **Wave**.
**Purpose:** let the ATEC Outage Portal tell all residents of an affected estate about a network outage through Wave, by SMS, email and a notice in the Wave client portal.

The Outage Portal decides *when* to communicate and *what* to say. That wording comes from approved templates and verified facts only. Wave decides *who* the residents of an estate are and delivers the message on its channels.

---

## 1. What Wave needs to add

### 1.1 Send (or update) an estate outage notice

```
POST {WAVE_BASE_URL}/api/outage-notices
Authorization: Bearer {API key}
Idempotency-Key: {delivery_id}
Content-Type: application/json
```

Request body:

```json
{
  "delivery_id": "6f1c…-uuid",                 // unique per send; also sent as Idempotency-Key
  "incident_reference": "INC-2026-000123",     // one outage = one reference, across many updates
  "estate": "Dowerview",                       // Wave's estate name (see 1.3); absent when account_code is used
  "account_code": null,                        // TEST ONLY: send to this single client account instead of the estate
  "network": "FSN",                            // FSN or FMAS: which brand/sender to use
  "kind": "initial_outage",                    // message type (initial_outage, technical update, restored, final_rfo, …)
  "notice_status": "open",                     // open | resolved: drives the portal notice (see 1.2)
  "channels": ["sms", "email", "portal"],
  "subject": "Network interruption – Dowerview [INC-2026-000123]",
  "text": "Dear Client,\n\nWe are aware of …",  // full message: email body and portal notice body
  "html": "<p>Dear Client,</p>…",               // same content as HTML for email
  "sms_text": "Dowerview: network interruption, our team is investigating. Next update by 16:00. Ref INC-2026-000123",
  "callback_url": "https://atec-outage-portal.vercel.app/api/webhooks/delivery/client-api"
}
```

Wave must:

1. **Authenticate** the Bearer key. Use a dedicated key that can only call this endpoint.
2. **Be idempotent.** If the same `delivery_id` or `Idempotency-Key` arrives again (for example after a network retry), return the original result and send **nothing** again.
3. **Resolve recipients:**
   - When `estate` is given: every **active** client account at that estate.
   - When `account_code` is given: **only** that one account. This is the test mode: the estate must be ignored entirely, and the message must never fan out to other clients.
4. **Deliver on each channel in `channels`,** using each client's own contact details and opt-outs:
   - `sms`: send `sms_text` exactly as given. It is at most 300 characters. Do not add to or rewrite it.
   - `email`: send `subject`, `text` and `html`. The From address and branding come from `network` (FSN → Fibre Suburb, FMAS → FMAS).
   - `portal`: show a notice to the estate's clients (see 1.2).
5. **Never change the wording.** The Outage Portal has already approved it. Wave only delivers it.
6. **Respond quickly** with `202 Accepted` and do the actual sending in the background:

```json
{ "id": "wave-notice-8841", "recipients": { "sms": 212, "email": 198, "portal": 230 } }
```

Errors:
- `400` / `422`: bad request (for example an unknown estate). The response body explains why. The portal does **not** retry these.
- `401` / `403`: bad key.
- `429` / `5xx`: temporary. The portal retries with backoff (1, 3, 10, 30, 60 min) and the same `delivery_id`.

### 1.2 The portal notice

- There is **one notice per `incident_reference` per estate**. Every later call for the same incident **replaces** the notice text, so clients always see the latest update and not a stack of old ones.
- When `notice_status` is `resolved` (sent with the restoration and final messages), mark the notice as resolved and take it off the active list. Keep it in history.

### 1.3 List estates (so both systems use the same names)

```
GET {WAVE_BASE_URL}/api/outage-notices/estates
Authorization: Bearer {API key}
→ 200 [ { "estate": "Dowerview", "active_accounts": 230 }, … ]
```

The Outage Portal uses this list to check that every site's "Residents list reference" matches an estate name in Wave exactly, and to flag sites that don't.

### 1.4 Delivery result callback (Wave → Outage Portal)

When sending for a notice has finished, Wave POSTs the result to `callback_url`:

```
POST {callback_url}
X-Signature: sha256={hex HMAC-SHA256 of the raw request body, using the shared webhook secret}
Content-Type: application/json

{ "delivery_id": "6f1c…-uuid", "message_id": "wave-notice-8841", "status": "delivered",
  "detail": "sms 210/212, email 196/198, portal 230" }
```

`status` is one of:
- `delivered`: at least one channel reached the residents.
- `failed`: nothing could be delivered.
- `deferred`: still trying.
- `bounced`: only used for single-account sends, when the address is invalid.

---

## 2. Settings exchanged (each side sets its own; never sent in chat or email)

| Setting | Created by | Stored in |
|---|---|---|
| Wave base URL | Wave | Outage Portal: `CLIENT_API_URL` |
| API key for the outage-notices endpoint | Wave | Outage Portal: `CLIENT_API_TOKEN` (Sensitive) |
| Webhook signing secret | Either side, then shared securely | Wave config, and Outage Portal `CLIENT_API_WEBHOOK_SECRET` (Sensitive) |

---

## 3. Safety rules (both sides)

- The Outage Portal has a **resident safety lock**: Off, then Test (single `account_code` only), then Live. It stays Off until the integration has been tested and signed off.
- Wave must treat `account_code` sends as **test sends to one account only**.
- Neither system may expose backhaul provider names or circuit details to clients. The Outage Portal never sends them, and Wave must not add them.

---

## 4. Test plan

1. Wave deploys the endpoint and the estates list, and creates the API key and webhook secret.
2. ATEC adds the three settings to the Outage Portal in Vercel.
3. The Outage Portal checks the estate names against its 180 sites, and any mismatches are fixed.
4. The resident lock is set to **Test** with ATEC's test account code. A simulated outage then runs through initial message, update, restored and RFO, and the test account receives each message by SMS, email and portal notice.
5. Once that has been signed off, the lock is switched to **Live**.
