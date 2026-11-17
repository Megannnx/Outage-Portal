# ATEC Outage Portal

This is the network outage communications portal for ATEC's FSN and FMAS fibre networks. It runs as Next.js 14 with Drizzle and Postgres. Production is on Vercel and Supabase, and a move to a self-hosted Linux VM is planned.

**Start here:**
- `docs/HANDOVER.md`: where everything lives, the current state, decisions made, and next steps.
- `docs/ARCHITECTURE.md`: how the system works.

## Commands

- `npm ci`: install dependencies (Node 22).
- `npm run typecheck`, `npm test`: the tests need a local Postgres at `postgres://portal:portal@localhost:5432/portal_test`, or wherever `TEST_DATABASE_URL` points. **Never point it at production**, because the tests drop the schema.
- `npm run dev` and `npm run worker`: run locally with a `.env.local` copied from `.env.example`.
- `npm run db:migrate`: applies `drizzle/*.sql`.

## Production

- Pushing to `main` deploys automatically to https://atec-outage-portal.vercel.app.
- Vercel: team `team_aUgCXmuWLPELeV1jJCMUSCLy`, project `prj_iPRIt7t0dqzzKChOYV945pQHKeQU`.
- Supabase project `pesxfrssoaniepgjmxxv`. A `pg_cron` job, `portal-tick`, calls `/api/cron/tick` every 30 seconds.
- `DELIVERY_MODE=capture` and resident sending is **off**. Megan switches these on herself after sign-off. Never switch them on without being asked.

## Rules: do not break these

1. **Never name a backhaul provider, alias, Connexifi or circuit ID in anything sent to clients.** `src/server/comms/privacy.ts` enforces this. There is deliberately no provider placeholder.
2. **Resident safety lock (`settings.residentDelivery`):** `off`, then `test` (test account codes only), then `live`. Nothing may reach residents while it is `off`.
3. **Template wording is frozen once submitted,** and a database trigger enforces it. To change wording, create a new version, then submit and approve it.
4. **`audit_logs` and `technical_updates` are append-only** (triggers), and the audit log is hash-chained.
5. **Customer wording comes only from approved templates and the admin vocabularies.** Extraction never writes customer text; the RFO is free text that Technical confirms.
6. **Never ask for, print or decrypt secrets.** Megan sets them in Vercel herself. Integration tokens are generated and stored in the database, and shown to admins in Admin › System.
7. **Every behaviour change gets a test.** The tests run against real Postgres.
8. **Keep docs in step with behaviour.** Update `docs/*.md` and the "Current state" section of `docs/HANDOVER.md` when things change.
