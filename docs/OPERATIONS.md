# Deployment & operations

## 1. Deploy (Docker Compose, self-hosted)

Requirements: a Linux VM (2 vCPU, 4 GB RAM is plenty), Docker Engine + Compose v2, a DNS name, outbound SMTP/HTTPS, inbound HTTPS from the NetXMS server.

```bash
git clone <repo> atec-outage-portal && cd atec-outage-portal
cp .env.example .env
# Fill in at least: POSTGRES_PASSWORD, DATABASE_URL (same password, host "db"), APP_ENCRYPTION_KEY,
# PUBLIC_BASE_URL, INGEST_TOKEN_NETXMS, BOOTSTRAP_ADMIN_EMAIL/PASSWORD. Keep DELIVERY_MODE=capture for now.
openssl rand -base64 32   # → APP_ENCRYPTION_KEY
openssl rand -hex 32      # → INGEST_TOKEN_NETXMS, BOUNCE_WEBHOOK_TOKEN, CLIENT_API_WEBHOOK_SECRET
PORTAL_DOMAIN=outages.atec.co.za docker compose --profile tls --profile backup up -d --build
docker compose logs -f migrate web worker
```

`migrate` runs migrations + reference data (idempotent) and creates the first administrator. Sign in, enrol MFA, then follow the go-live checklist in `ADMIN_GUIDE.md`.

Upgrades: `git pull && docker compose up -d --build` — `migrate` runs first, `web`/`worker` start after it succeeds. Workers stop gracefully (30 s) and leased jobs are recovered automatically.

### Environment variables

See `.env.example` (every variable is commented). Secrets live only in `.env` (mode 600) or your secret store — never in git. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (`DATABASE_SSL=true` for managed DBs) |
| `APP_ENCRYPTION_KEY` | 32-byte base64 key encrypting MFA secrets — back it up; losing it means users re-enrol MFA |
| `PUBLIC_BASE_URL` | Used in dispatch links and callbacks |
| `DELIVERY_MODE` | `capture` (nothing sent, red banner) or `live` |
| `CLIENT_API_*` | Residents' communications API |
| `SMTP_*` | ISP + internal email |
| `INGEST_TOKEN_NETXMS`, `INGEST_ALLOWED_IPS` | NetXMS ingestion auth |
| `TELEGRAM_*` | Optional backup ingestion |
| `ANTHROPIC_API_KEY` | Optional AI cross-check |
| `MFA_REQUIRED_ALL` | Force MFA for every role (admins always require it) |
| `TEMPLATE_SELF_APPROVAL` | Allow an admin to approve their own wording (single-admin teams only) |
| `RETENTION_RAW_EVENT_DAYS`, `RETENTION_JOB_DAYS` | Retention (defaults 180 / 30) |

## 2. Monitoring the portal itself

* `GET /api/health` → `200 {"ok":true,"db":true,"worker":true}` or `503`. Point your uptime monitor (or NetXMS itself) at it. `worker:false` means timers and deliveries are not running.
* In-app: header pill (Live / Worker down), alert bell, **Admin › System health** (integrations, queue, dead-letter jobs, unmatched monitoring objects, audit-chain verification).
* Logs: `docker compose logs worker web` (structured `[worker]`, `[api]`, `[migrate]` prefixes). Ship them to your log platform.
* Alerts the portal raises itself: worker/queue backlog, NetXMS silence, adapter not configured, delivery retrying/failed, recipient invalid, missing template, unmatched monitoring object, dead jobs, retrospective outages.

## 3. Backup & recovery

* `backup` profile writes a nightly `pg_dump -Fc` to `./backups` and keeps 30 days. **Copy `./backups` off the host** (e.g. `rclone` to object storage) and keep `.env` (especially `APP_ENCRYPTION_KEY`) in your password vault.
* Restore:
  ```bash
  docker compose stop web worker
  docker compose exec -T db pg_restore -U portal -d portal --clean --if-exists < backups/portal-YYYYMMDDTHHMMSSZ.dump
  docker compose up -d web worker
  ```
  On start the worker runs every overdue job immediately, so validations, 2-hour updates and retries catch up. Review **Operations** for anything that changed while the portal was down (NetXMS events during the outage are not replayed — check NetXMS for sites still down).
* Test a restore quarterly into a scratch database.

## 4. Runbooks

**Worker down banner / `/api/health` 503**
1. `docker compose ps worker` → `docker compose logs --tail=200 worker`.
2. DB reachable? `docker compose exec db pg_isready`.
3. `docker compose up -d worker`. Overdue jobs execute immediately; check **Admin › System health** for dead jobs.

**"No events from NetXMS for N min"**
1. Is anything actually down? Check NetXMS.
2. On the NetXMS server run the test `curl` from `NETXMS_SETUP.md`. 401 → token mismatch; 403 → `INGEST_ALLOWED_IPS`; timeout → firewall/DNS.
3. Check the EPP rule and action are enabled. Confirm the heartbeat task runs.

**SMTP / client API failing (deliveries retrying)**
1. **Admin › System health › Integrations** shows the last error.
2. Fix credentials/connectivity; retries continue automatically (1, 3, 10, 30, 60 min). Messages that exhausted retries show as *failed* on the incident — they are not resent automatically; the next scheduled update goes out normally.
3. If a critical update failed, re-trigger by entering a technical update or wait for the next cycle.

**Dead-letter jobs**
**Admin › System health › Dead-letter jobs** → read the error → fix cause → **Retry**. Handlers are idempotent, retrying never double-sends.

**Unknown monitoring object alert**
Add a monitoring identifier for the object (Admin › Sites & monitoring) or ignore if it is not a site device.

**Wrong cause confirmed**
Service Desk taps the correct cause. Unsent messages for the old cause are cancelled; the corrected wording goes out; both decisions stay in the audit log. Delivered messages cannot be recalled — consider a custom "correction" template.

**A recipient bounces repeatedly**
**Admin › ISPs & contacts** lists it under *Delivery & data-quality problems*. Correct the address, set it back to *active* (bounce count resets).

**Template missing / not published alert**
An administrator publishes the template (needs a second admin to approve). Until then the engine falls back down the chain (ultimately to the initial outage wording).

**Incident open but site is actually up (missed UP event)**
Send the UP from NetXMS (re-trigger) or post a test UP via the ingestion endpoint with the real timestamp; restoration flows normally.

**Key rotation**
* Ingestion tokens: set a new value in `.env` and NetXMS, restart `web`.
* `APP_ENCRYPTION_KEY`: rotation invalidates MFA secrets → users re-enrol (Admin › Users › Reset two-factor).

## 5. Security hardening checklist

- [ ] TLS only (Caddy profile or your reverse proxy); `COOKIE_SECURE=true`.
- [ ] Web port bound to localhost (`WEB_BIND=127.0.0.1`) behind the proxy.
- [ ] `INGEST_ALLOWED_IPS` set to the NetXMS server.
- [ ] Two administrators with MFA; `TEMPLATE_SELF_APPROVAL=false`.
- [ ] SPF/DKIM/DMARC for the sender domain.
- [ ] Off-site, encrypted backups; `.env` in a vault.
- [ ] OS patching and Docker image rebuilds monthly (`docker compose build --pull`).
- [ ] Review **Admin › System health › Audit log integrity** monthly.

## 6. POPIA notes

Personal information held: staff accounts, ISP business contact details, optional direct resident contacts. Residents are normally addressed through the client system's distribution reference, so their details stay in that system. Every contact change is audited. Raw monitoring payloads, expired sessions and finished jobs are purged automatically. Incident and communication history is a business record kept for reporting — set your retention policy and, if required, schedule an annual purge of old `communication_deliveries.address` values.
