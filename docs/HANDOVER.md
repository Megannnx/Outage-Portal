# ATEC Outage Portal: handover to Claude Code

**State as of 17 November 2026.** The latest code is commit `5a85a68` on `main`, and it is what is deployed in production.
This document lets someone (or Claude Code) pick the project up with no other context.
For how the system works in depth, see `docs/ARCHITECTURE.md`. This document covers **where things are, what state they're in, what was decided, and what's next.**

---

## 1. What this is

The Network Outage Communications & Incident Management Portal for ATEC's two fibre networks, **FSN (Fibre Suburb)** and **FMAS**.

1. NetXMS detects a site going down and posts the event to the portal. Telegram is a secondary feed.
2. If the site is still down after **3 minutes**, the portal tells residents and ISPs automatically.
3. Service Desk confirms the cause, Technical pastes provider updates (which are parsed into verified facts only), and the portal sends approved-template updates at least every **2 hours**.
4. After restoration it sends a restored notice, then runs the reason-for-outage (RFO) workflow.

There are also escalations, technician dispatch, monthly reports, RBAC with MFA, and a tamper-evident audit log.

---

## 2. Where everything lives

| Thing | Where | Notes |
|---|---|---|
| Source code | GitHub `Megannnx/Outage-Portal`, branch `main` | ⚠ The repo is **public**; make it private (see §11). The local clone's remote may still say `outage-portal`, and GitHub redirects it. |
| Production app | https://atec-outage-portal.vercel.app | Pushes to `main` deploy automatically (about 2 minutes). |
| Vercel | Team **ATEC Megan** `team_aUgCXmuWLPELeV1jJCMUSCLy`; project **atec-outage-portal** `prj_iPRIt7t0dqzzKChOYV945pQHKeQU` | Region `lhr1`, Node 22. SSO protection on preview deployments only. |
| Database | Supabase project **ATEC Outage Portal**, id `pesxfrssoaniepgjmxxv`, region eu-west-2, Postgres 17 | The app connects with the **transaction pooler** string (`DATABASE_URL`, set by Megan as a Sensitive variable). |
| Scheduler (hosted) | Supabase `pg_cron` job `portal-tick`, runs every **30 seconds** | Calls `POST /api/cron/tick` through `pg_net`, using the token stored in DB setting `secret.tickToken`. A second job, `portal-cron-log-cleanup`, runs daily at 03:17. |
| Outgoing email | Google Workspace: `noreply@fibresuburb.co.za` (FSN) and `noreply@fmas.co.za` (FMAS) via `smtp.gmail.com:587` | Each mailbox uses an App Password, held only in Vercel. Both were proven working on 16 Nov with a test send. |
| Architecture doc | Claude project "Automated Comms New" › `claude/outage-portal-architecture.md` | A copy of `docs/ARCHITECTURE.md`, which may lag behind the repo. |
| Other Supabase projects | "Household" (paused) and "Megannnx's Project" (an older, unrelated outage prototype) | **Don't touch either.** |

---

## 3. Getting started in Claude Code

```bash
git clone https://github.com/Megannnx/Outage-Portal.git atec-outage-portal
cd atec-outage-portal
npm ci                      # Node 22 required

# Tests need a disposable local Postgres (the suite drops and recreates the schema)
docker run -d --name portal-pg -e POSTGRES_USER=portal -e POSTGRES_PASSWORD=portal \
  -e POSTGRES_DB=portal_test -p 5432:5432 postgres:17-alpine
npm run typecheck
npm test                    # 64 tests, all should pass (they run against real Postgres)
```

- **Running the tests:**
  - The test database defaults to `postgres://portal:portal@localhost:5432/portal_test`. Override it with `TEST_DATABASE_URL`.
  - **Never point `TEST_DATABASE_URL` at production.** The tests drop the `public` schema.
- **Running the app locally:**
  - Create `.env.local` from `.env.example`, pointing `DATABASE_URL` at a local database.
  - Then run `npm run db:migrate`, `npm run dev`, and `npm run worker` in a second terminal.
  - Open `/setup` to create the first admin, or run `npm run demo:seed` for demo data.
- **Full stack in Docker:** `docker compose up`. See `docs/SELF_HOSTING.md`.
- **MCP servers worth connecting in Claude Code:**
  - **Supabase:** for SQL on the live database, using project id `pesxfrssoaniepgjmxxv`.
  - **Vercel:** for deployments, logs and environment variable *names*, using the team and project ids above.
  - **GitHub.**

  All the earlier work used these three.

---

## 4. Architecture in one screen

- **Stack:**
  - TypeScript, Next.js 14.2 (App Router), React 18, Tailwind (ATEC black/red, dark by default).
  - Drizzle ORM 0.45 with `pg`, and zod 4.
  - nodemailer, exceljs and pdfkit; otplib for TOTP MFA; bcryptjs.
  - Optional `@anthropic-ai/sdk`, for an AI cross-check of the extraction (off unless `ANTHROPIC_API_KEY` is set).
- **Job queue:** a durable queue in Postgres (the `jobs` table).
  - Jobs are claimed with `FOR UPDATE SKIP LOCKED`, with leases and a `dedupe_key`, and failures go to a dead-letter state.
  - Self-hosted, the `worker` processes run the queue. On Vercel, the 30-second `pg_cron` tick calls `/api/cron/tick`, which drains it.
- **Incident phases:** `validating → active → restoring → awaiting_rfo → resolved`.
  - `interruption` means the site came back within 3 minutes, so no external messages were sent.
  - Each site is serialised with `pg_advisory_xact_lock`, and each incident uses optimistic concurrency on `incidents.version`.
- **Communications:**
  - Templates are strictly rendered: `{{var}}` must be present, `{{#var}}…{{/var}}` shows a section only if the value exists, and `{{^var}}…{{/var}}` shows it only if the value is missing.
  - If the facts a template needs aren't verified, the engine falls back along a chain to a template that only uses verified facts.
  - The rendered text is frozen per communication, and there is one delivery row per recipient.
  - Channels:
    - `smtp`: ISPs and internal staff.
    - `client_api`: residents, through **Wave** (see §7).
    - `capture`: records messages without sending them; used in demo and test.
- **Extraction:** deterministic rules (negation, conflicts, evidence, confidence) plus the optional AI check.
  - Customer-facing words come **only** from admin vocabularies (fault types, cause public descriptions).
  - The RFO is the only free text, and Technical must confirm it.
- **Integrity:**
  - The audit log is hash-chained and append-only (`canonicalJson`), and can be verified in Admin › Audit.
  - Database triggers make technical notes immutable and **freeze template wording once it has been submitted**.

---

## 5. Code map (where to look)

| Area | Files |
|---|---|
| Schema / migrations | `src/server/db/schema.ts`, `drizzle/0000…0003*.sql`, `src/server/db/client.ts` |
| Incident engine | `src/server/incidents/lifecycle.ts` (event processing, site matching by object ID, then IP, then name), `actions.ts` (cause, technical update, dispatch, RFO), `transitions.ts` |
| Messages | `src/server/comms/engine.ts` (plan, create, deliver), `render.ts`, `templates.ts`, `privacy.ts`, `smtp-test.ts` |
| Delivery adapters | `src/server/comms/adapters/{smtp,client-api,capture,index,types}.ts` |
| Wave API (residents) | `src/server/integrations/wave.ts`, `src/app/api/wave/v1/**` |
| Default wording / vocab | `src/server/domain/seed-data.ts`, `catalog.ts` (message kinds and placeholders), `settings.ts` (policy settings and defaults) |
| Monitoring intake | `src/server/ingestion/normalize.ts`, `auth.ts`, `src/app/api/ingest/{netxms,telegram,generic/[source]}` |
| Scheduler | `src/server/scheduler/{jobs,runner}.ts`, `src/app/api/cron/tick`, `src/worker/main.ts` |
| Escalations / health / retention | `src/server/escalations/engine.ts` |
| Admin | `src/server/admin/{resources,site-import,readiness,demo-cleanup}.ts`, `src/components/admin/*` |
| Secrets | `src/server/lib/secrets.ts`. Each secret is read from its environment variable, or else auto-generated and stored in the database (`settings` key `secret.<name>`). |
| Reports | `src/server/reports/{metrics,export,query}.ts` |
| Self-hosting | `install.sh`, `docker-compose.yml`, `deploy/{atec-portal,Caddyfile,backup.sh}`, `docs/SELF_HOSTING.md` |

---

## 6. Rules that must not be broken

1. **Backhaul providers are private.**
   - No client message may name a provider, alias, Connexifi, or a circuit ID.
   - There is deliberately **no** `{{provider_name}}` placeholder.
   - `comms/privacy.ts` rejects provider terms in templates, cause and fault wording, and RFOs. Keep it that way.
2. **Resident safety lock:**
   - `settings.residentDelivery` is `off` / `test` / `live`, and is currently **`off`**.
   - Nothing reaches residents unless it is `live`. In `test` mode, only `residentTestAccounts` receive messages.
   - Megan's instruction: **nothing goes to residents until the portal is finished and tested.**
3. **`DELIVERY_MODE` is currently `capture`.** While it is, nothing is sent except admin SMTP test emails and Wave Test-mode notices. Megan switches it to `live` herself when everything is signed off.
4. **Template wording is frozen once submitted.**
   - Never `UPDATE template_versions.body` (the trigger will refuse anyway).
   - Instead, create a new version, then submit and approve it. Rejecting the old version is allowed.
5. **Never modify `audit_logs` or `technical_updates`.** They are append-only, enforced by triggers, and the audit log is hash-chained.
6. **Approval:** a template can't be approved by the person who wrote it (`TEMPLATE_SELF_APPROVAL` is off), so two admins are needed.
7. **Customer wording only ever comes from approved templates and the admin vocabularies.** The extraction step never writes customer text.
8. **Credentials never pass through chat.** Megan sets secrets in Vercel herself, and they are only ever listed by name, never decrypted. The integration tokens are viewable by admins in the app.
9. **Tests run against real Postgres.** Add a test for every behaviour change; `tests/edge-cases.test.ts` covers the spec's edge cases.

---

## 7. Integrations: current status

| Integration | Status | Details |
|---|---|---|
| **NetXMS** (monitoring) | ⏳ Not connected yet | `POST /api/ingest/netxms` with `Authorization: Bearer <NetXMS ingestion token>` (Admin › System › Integration tokens). Setup is in `docs/NETXMS_SETUP.md`. Sites are matched by NetXMS object ID, then **headend IP** (`%a`), then device name. |
| **Telegram** | Optional secondary feed | `/api/ingest/telegram`, using `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_ALLOWED_CHAT_IDS`. |
| **Email (SMTP)** | ✅ Working | Each site's **Network** field selects the mailbox: FSN sends from noreply@fibresuburb.co.za and FMAS from noreply@fmas.co.za. Configured with `SMTP_HOST`/`SMTP_PORT` plus `SMTP_<NET>_USER`, `SMTP_<NET>_PASSWORD` and `SMTP_<NET>_FROM`. Test sends are in Admin › Readiness › "Send a test email". |
| **Wave** (residents: SMS, email, portal notice) | ⏳ Waiting on Wave | The portal provides `/api/wave/v1` (claim notices, report result, list sites, current outages), authenticated with the **Wave API key**. The full contract is in `docs/WAVE_INTEGRATION.md`; Megan has it to brief the Wave build. Wave is a separate Claude-built ticketing system whose code isn't in this GitHub account. Notices are leased for 5 minutes, use `delivery_id` for idempotency, and an alert fires if Wave stops collecting for more than 5 minutes. **The SMS text is the approved subject line** (a separate SMS template could be added later). Setting `CLIENT_API_URL` switches to the older *push* mode instead; don't set it. |
| **Bounce processing** | Optional | `BOUNCE_*` variables and `scripts/bounce-processor.ts`. |

**Vercel environment variables currently set** (names only): `DATABASE_URL` (Production and Preview), `PUBLIC_BASE_URL`, `DELIVERY_MODE=capture`, `DISPLAY_TIMEZONE=Africa/Johannesburg`, `SESSION_IDLE_MINUTES=720`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_FSN_USER`, `SMTP_FSN_FROM`, `SMTP_FSN_PASSWORD`, `SMTP_FMAS_USER`, `SMTP_FMAS_FROM`, `SMTP_FMAS_PASSWORD`.
Integration tokens (`ingestNetxms`, `ingestGeneric`, `bounceWebhook`, `waveApi`, `tickToken`) and `appEncryptionKey` are generated and stored in the database, because they aren't set as environment variables.

---

## 8. Live data (production, 17 Nov 2026)

- **Sites:** 180 real sites, 136 FMAS and 44 FSN; demo data has been removed.
  - The site codes are provisional, except DWV (Dowerview) and HZD (Hazeldean). Confirm them against NetXMS naming.
  - Silver Leaf exists on both networks: `SIL` is FSN and `SIL2` is FMAS. Silver Lakes is `SIL3`.
- **Monitoring identifiers:**
  - **69** FMAS sites have a headend IP identifier (10.75.x.1, from the Gaia backhaul sheet).
  - **111 sites have no monitoring identifier yet.** NetXMS events for them will show up as "unmatched".
- **Backhaul:**

  | Provider | Sites |
  |---|---|
  | MetroFibre Networx (MFN) | 99 |
  | Dark Fibre Africa | 52 |
  | Liquid Intelligent Technologies | 12 |
  | Comsol | 6 |
  | Openserve | 5 |
  | Link Africa | 2 |
  | No provider yet: **PEP** Pecan Place, **SMR** The Somerset, **KNG** Kingsview, **VLE** Verdeau | 4 |

  - The circuit ID, upstream (Teraco JHB or CPT plus provider), VLAN, rate limit and backhaul size are stored in the site fields and notes.
  - The provider "Vumatel" was demo data and isn't used by any site.
- **ISPs:** 26 ISPs, linked to every site by network and region (3,224 links). The KwaZulu-Natal and North West sites use the Gauteng list. **No ISP email contacts have been loaded yet**; Megan will send them.
- **Users:** one admin, with MFA on. There is no second admin, Service Desk or Technical user yet.
- **Templates:** 22 versions are pending approval and 4 were rejected (the old provider-naming wording). **None are published.** The four reworded backhaul messages are version 2.
- **Settings:**
  - Resident sending is `off`.
  - Support contacts: FSN is `Fibre Suburb Support: support@fibresuburb.co.za` and FMAS is `FMAS Support: support@fmas.co.za`.
- **Incidents:** none; the demo incidents were removed.

Source spreadsheets that were imported (Megan has the originals):
- `FSN_On-Site_Contact_Sheet.xlsx` and `FMAS_OC_Sheet_2026_1.xlsx`: sites and on-site contacts.
- `Gaia_Backhaul_19_Oct_2026.xlsx`: FMAS backhaul and headend IPs.
- `Backhaul_Sheet_latest.xlsx`: VLANs and rate limits, plus the "MFN 1G by default" rule.
- `ISP_VLANs_FMAS_FSN.xlsx`: ISPs by network and region.

The **sites spreadsheet** can be exported and re-imported from Admin › Sites. It shows a preview before applying, and matches rows on Portal ID, then code, then name.

---

## 9. Decisions made (and why)

| Decision | Detail |
|---|---|
| Backhaul is private | Megan does not want provider names shared with clients. The wording was changed to "a network fault outside the estate", and privacy guards were added. |
| Connexifi rule | Where the sheet lists Connexifi plus another provider, the second is the **real** provider; Connexifi is only the contract. This is recorded in the notes as "via Connexifi (contract)". |
| Default backhaul | Any site not listed on the backhaul sheets is **MetroFibre Networx at 1 Gbps**, per Megan. Exceptions: Garlington 2 Gbps, Southdowns 4 Gbps. |
| Backhaul sheet conflicts | The Galleries, Oxford Five One and Edenburg Terrace are Liquid on the Gaia sheet but Dark Fibre Africa VLANs on the latest sheet. **Kept as Liquid**, pending Megan. |
| Fairway View | Matched to "Fairway View. Pollak Park" (10.75.38.1), not "3XCom MDU's (Fairway View)". |
| Edward Heights | New FMAS Western Cape site (EDH) created from the Gaia sheet. |
| Secondary links | Dartford's Comsol line and Helderberg Manor's Arun Wireless failover are **notes only**, not monitored as outages. |
| ISPs | One ISP record per company; spelling variants and the Afrihost PPPoE and Intercel CPT entries were merged. **Reflex and Gigawave are different companies**, per Megan. |
| Per-network branding | ISP email is sent from that network's mailbox, and each network has its own support line. |
| Wave direction | The **portal provides the API and Wave pulls from it**, at Megan's request. Wave doesn't need to expose an API. |
| Hosting | Vercel and Supabase for now. Megan plans to **move to a self-hosted Linux VM** later, using `install.sh` and `atec-portal import-supabase`; see `docs/SELF_HOSTING.md`. |

---

## 10. What's next (in order)

| # | Task | Owner |
|---|---|---|
| 1 | **Connect NetXMS:** add the webhook action (docs/NETXMS_SETUP.md), restrict it to the headend routers, and run one real down/up test. | Megan + Claude |
| 2 | **Link the remaining 111 sites to NetXMS.** Get a NetXMS export of router name, IP and object ID, then load it through the sites spreadsheet ("NetXMS object ID" / "Headend IP" columns) or SQL. | Megan provides the export, Claude loads it |
| 3 | **Load ISP email contacts** under Admin › Recipients with audience ISP, or as a bulk import. | Megan provides the list |
| 4 | **Wave:** the Wave team builds the collector from `docs/WAVE_INTEGRATION.md` and stores the Wave API key. Then set resident sending to **Test** with Megan's test account code and run a full simulated outage (initial, update, restored, RFO). | Wave + Megan + Claude |
| 5 | **Second admin plus Service Desk and Technical users**, all with MFA. The second admin reviews and **approves the templates**. | Megan |
| 6 | **Answer the data questions:** the provider for PEP, SMR, KNG and VLE; Liquid or Dark Fibre Africa for GLL, OFO and EDT; confirm the provisional site codes; whether Glendower Heights has moved to Dark Fibre Africa. | Megan |
| 7 | Add internal contacts (NOC, management) for escalations and dispatch emails (`DISPATCH_EMAILS`). | Megan |
| 8 | **Go-live:** Admin › Readiness all green, then `DELIVERY_MODE=live` in Vercel and redeploy, then a drill. Switch resident sending to **Live** only after the Wave test is signed off. | Megan |
| 9 | Move to the self-hosted VM, then disable the Supabase `portal-tick` cron job and the Vercel project. | Later |

**Optional improvements that were discussed:**
- A separate approved SMS wording instead of using the subject line.
- Dropping the provider breakdown from monthly reports if those reports are ever shared with clients.

---

## 11. Gotchas & housekeeping

- **⚠ Make the GitHub repo private:** Settings → General → Danger Zone → Change visibility. It contains no secrets, but it does contain internal design details. Vercel keeps deploying normally after the change.
- **Migrations on the hosted database:**
  - Apply new `drizzle/*.sql` files to Supabase, either with `DATABASE_URL=<prod> npm run db:migrate` from a trusted machine or with Supabase `apply_migration`.
  - If you use `apply_migration`, also insert the row into `drizzle.__drizzle_migrations`: `hash` is the sha256 of the SQL file, and `created_at` is the journal's `when` value.
  - All four migrations are recorded as of today.
- **Local test Postgres sometimes stops.** Restart it with `pg_ctlcluster 16 main start` in the old sandbox, or `docker start portal-pg`.
- **The Vercel function limit is 60 seconds.** The SSE stream reconnects every 50 seconds, and the cron tick processes in batches.
- **Admin › Readiness** is the single source of truth for what's missing before go-live. It includes Wave connection status, both SMTP accounts and the resident lock.
- **Changing data directly in SQL:** prefer the admin UI or the spreadsheet import, because they write audit entries. Direct SQL was used for the bulk imports above.
- **Commit identity:** earlier commits use `ATEC Portal Build <portal-build@users.noreply.github.com>`. Use your own normal Git identity from now on.

---

## 12. Suggested first prompt in Claude Code

> Read `CLAUDE.md` and `docs/HANDOVER.md`, run `npm ci && npm run typecheck && npm test` against a local Postgres, and confirm everything passes. Then check Admin › Readiness on production (via the Supabase/Vercel MCP tools) and summarise what's still outstanding from §10.
