# Wave integration: the Outage Portal API for resident notices

**For:** the team (or Claude session) that builds and maintains **Wave**, ATEC's client and ticketing system.
**What Wave does:** connect to the ATEC Outage Portal, collect the resident outage notices that are ready, send each one to the estate's clients by **SMS, email and a notice in the Wave client portal**, and report back what happened.

The Outage Portal decides *when* residents are told and *what* they are told. The wording comes from approved templates and verified facts only. Wave decides *who* the residents of an estate are, and delivers the message. Wave does **not** need to expose any API of its own. It only calls the portal.

---

## 1. Connection details

| Item | Value |
|---|---|
| Base URL | `https://atec-outage-portal.vercel.app/api/wave/v1` |
| Authentication | `Authorization: Bearer {Wave API key}` on every request |
| Where the key comes from | An ATEC administrator copies it from **Outage Portal › Admin › System › Integration tokens › "Wave API key"**. Store it as a secret in Wave's settings. Never put it in code, chat or email. |
| Format | JSON over HTTPS |

---

## 2. Endpoints

### 2.1 Collect notices that are ready to send

```
POST /notices/claim?limit=25
```

Wave should call this **every 30–60 seconds**. The response contains the notices to send now:

```json
{
  "lease_seconds": 300,
  "notices": [
    {
      "delivery_id": "6f1c2d1e-…",                 // the ID Wave uses when reporting back (2.2)
      "incident_reference": "INC-2026-000123",     // one outage = one reference, across many updates
      "estate": "Dowerview",                       // send to every active client at this estate…
      "account_code": null,                        // …OR, when set, ONLY to this one client account
      "test": false,                               // true when account_code is set (test send)
      "network": "FSN",                            // FSN or FMAS: which brand/sender to use
      "site_code": "DWV",
      "site_name": "Dowerview",
      "kind": "initial_outage",                    // message type
      "kind_label": "Initial outage detected",
      "notice_status": "open",                     // open | resolved (see 3.3)
      "channels": ["sms", "email", "portal"],
      "subject": "Network interruption – Dowerview [INC-2026-000123]",
      "text": "Dear Client,\n\nWe are aware of …", // email body (plain text) and portal notice text
      "html": "<div …><p>Dear Client,</p>…</div>", // email body (HTML)
      "sms_text": "Network interruption – Dowerview [INC-2026-000123]",
      "created_at": "2026-11-16T12:01:05.000Z",
      "lease_expires_at": "2026-11-16T12:06:05.000Z"
    }
  ]
}
```

- A collected notice is **leased to Wave for 5 minutes**. If Wave doesn't report a result (2.2) within that time, the portal offers the notice again. Wave must therefore treat `delivery_id` as an **idempotency key**: if it has already sent a `delivery_id`, it must not send it again. It just reports the result again.
- An empty `notices` list means there is nothing to send.
- When `account_code` is set, `estate` is `null`. Send to **that single account only**. These are test sends, and their subject starts with `[TEST]`.

### 2.2 Report the result

```
POST /notices/{delivery_id}/result
```

```json
{ "status": "delivered", "wave_reference": "wave-notice-8841",
  "counts": { "sms": 210, "email": 196, "portal": 230 },
  "detail": "2 SMS failed (invalid numbers)" }
```

`status` must be one of:
- `accepted`: Wave has taken the notice and is still sending. This is optional and stops the lease from expiring early.
- `delivered`: the notice went out to the estate's residents (at least one channel reached them).
- `failed`: nothing could be delivered, for example because the estate is unknown in Wave or there are no active clients there. Put the reason in `detail`. The portal raises an alert to ATEC staff.

Reporting the same result twice is harmless.

### 2.3 Sites and their Wave estate names

```
GET /sites
→ { "sites": [ { "site_code": "DWV", "site_name": "Dowerview", "estate": "Dowerview", "network": "FSN", "region": "Gauteng" }, … ] }
```

`estate` is the name the portal will send in notices. Wave should match it to its own estate names, ignoring case. If an estate can't be matched, report `failed` with `detail: "unknown estate"`. Wave may also call `/sites` once a day and list any mismatches for ATEC to fix. ATEC fixes a mismatch by setting the site's **Residents list reference** in the portal to Wave's exact estate name.

### 2.4 Current outages (optional, for the client portal banner)

```
GET /outages
→ { "outages": [ { "incident_reference": "INC-2026-000123", "estate": "Dowerview", "network": "FSN",
                   "notice_status": "open", "outage_started_at": "…", "restored_at": null,
                   "latest": { "kind": "eta_available", "subject": "…", "text": "…", "sent_at": "…" } } ] }
```

This lists open outages, plus outages resolved in the last 24 hours, each with the latest message residents were sent. Wave can use it to rebuild its portal notices, for example after downtime.

---

## 3. Delivery rules for Wave

1. **Recipients:**
   - When `estate` is given: every **active** client account at that estate, using each client's own mobile number and email address and respecting their opt-outs.
   - When `account_code` is given: **only** that account.
2. **SMS:** send `sms_text` exactly as given. It is at most 300 characters.
3. **Email:** send `subject` plus `html` (with `text` as the plain-text part). Use the From address and branding for `network`: FSN is Fibre Suburb and FMAS is FMAS.
4. **Portal notice:**
   - Keep **one notice per `incident_reference` per estate**.
   - Every new notice for the same incident **replaces** the text, so clients always see the latest update and not a pile of old ones.
   - When `notice_status` is `resolved`, mark the notice as resolved and take it off the active list. Keep it in history.
5. **Never change the wording.** It has already been approved. Wave only delivers it.
6. **Never add backhaul provider names or circuit details** to anything clients see.

---

## 4. What the portal guarantees

- **Safety lock:**
  - While ATEC has resident sending set to **Off**, the portal hands Wave nothing.
  - In **Test** mode it only hands Wave notices for ATEC's test account (`account_code`).
  - Only in **Live** mode does it hand Wave estate-wide notices.
- **No stale notices:** if the network is restored before Wave collects an "outage" notice, that notice is cancelled and never handed out. The "restored" notice follows instead.
- **Alerting:** if Wave stops collecting for more than 5 minutes, ATEC staff get an alert ("residents are not being informed").
- Each notice's delivery result is shown on the incident in the portal and counted in the monthly reports.

---

## 5. Test plan

1. Wave builds the collector (2.1, 2.2) and stores the base URL and API key in its settings.
2. ATEC sets the portal's resident sending to **Test**, using ATEC's test account code.
3. ATEC runs a simulated outage. Wave collects and sends each message (initial, update, restored, reason-for-outage) to the test account by SMS, email and portal notice, and reports `delivered`.
4. ATEC checks the messages on the test account's phone, inbox and portal, and checks that the portal shows them as delivered.
5. Wave checks `/sites` for estate-name mismatches, and ATEC fixes any.
6. Once that has been signed off, ATEC switches resident sending to **Live**.
