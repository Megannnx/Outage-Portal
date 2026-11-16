# ATEC Outage Operations Portal

Automated network-outage communications and incident management for ATEC.

**NetXMS detects the outage → the portal validates it for 3 minutes → the approved first message goes out automatically → Service Desk confirms the cause with one tap → Technical pastes provider updates (facts are verified, never invented) → approved updates go out immediately and at least every 2 hours → monitoring confirms a stable restoration → approved restoration notice → verified RFO → final message → resolved → monthly management reports.**

Service Desk staff never write outage emails. Technical never chooses wording or timing. Management never compiles reports by hand.

## Run locally

```bash
npm ci
cp .env.example .env          # set DATABASE_URL, APP_ENCRYPTION_KEY; keep DELIVERY_MODE=capture
npm run demo:seed             # DEMO ONLY: demo sites/users + a simulated morning of outages
npm run dev                   # web on http://localhost:3000
npm run worker                # background worker (timers, delivery, escalations) — required
npm test                      # 50+ workflow/edge-case tests against real Postgres (TEST_DATABASE_URL)
```

Demo logins (demo seed only): `desk@demo.atec`, `noc@demo.atec`, `admin@demo.atec`, `manager@demo.atec` — password `demo-password-123`.

## Production

Self-hosted Docker Compose: see **[docs/OPERATIONS.md](docs/OPERATIONS.md)**. Then **[docs/NETXMS_SETUP.md](docs/NETXMS_SETUP.md)** and the go-live checklist in **[docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)**.

## Before go-live you must provide

| Item | Why |
|---|---|
| Client-base communications API details (URL, auth, payload, status callbacks) | Resident messages. The adapter follows a documented contract (docs/INTEGRATIONS.md) — adjust one file if the real API differs. |
| SMTP relay + sender domain with SPF/DKIM/DMARC; a bounce mailbox | ISP notices, internal notifications, delivery/bounce tracking |
| NetXMS server action + EPP rule + heartbeat | Outage detection |
| Site list with NetXMS object IDs, resident distribution refs, ISP associations | Correct targeting |
| Two administrators | Four-eyes approval of wording |
| Approved wording for each template | Starter wording ships as *pending approval*; nothing sends until approved |

Until then run with `DELIVERY_MODE=capture`: a red banner shows on every screen and nothing leaves the system.

## Documentation

* [Architecture, state machine, schema, security, failure recovery, risks](docs/ARCHITECTURE.md)
* [NetXMS integration](docs/NETXMS_SETUP.md) · [Other integrations](docs/INTEGRATIONS.md)
* [Deployment, monitoring, backups, runbooks, POPIA](docs/OPERATIONS.md)
* [Administrator guide](docs/ADMIN_GUIDE.md) · [Testing & edge-case map](docs/TESTING.md)

## Layout

```
src/server/        domain engine (no UI): ingestion, incidents, scheduler, comms, extraction, escalations, reports, auth, audit
src/worker/        background worker entrypoint
src/app/           Next.js pages + API routes
src/components/    UI (ops workspace, admin, reports)
drizzle/           SQL migrations (incl. integrity triggers)
scripts/           seed, demo seed, bounce processor
tests/             acceptance, edge-case, report and unit tests
deploy/            Caddy, backup script
```
