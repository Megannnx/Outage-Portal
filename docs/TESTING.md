# Testing

```bash
# Needs a disposable Postgres database (it is wiped):
export TEST_DATABASE_URL=postgres://portal:portal@localhost:5432/portal_test
npm test
```

Tests run against **real PostgreSQL** (all locking, partial indexes and triggers are exercised) with a controllable clock, so the 3-minute and 2-hour rules are tested minute by minute. External systems use the capture adapter (`DELIVERY_MODE=capture`) — tests can make the provider fail transiently or permanently. Nothing is presented as a live connection.

## Acceptance scenarios (`tests/acceptance.test.ts`, `tests/reports.test.ts`)

| Scenario | Test |
|---|---|
| A Basic outage | initial message after exactly 3 min, residents + each ISP contact individually, schedule set |
| B Area power | power template, 2-hourly *power still unavailable*, stops on restoration |
| C Server-room power | urgent dispatch required, internal email sent, tracked, escalated L1/L2, cleared on acknowledgement |
| D Power confirmed | Technical assigned + notified, "power ok" wording makes no backhaul claim, update extracted & sent |
| E No information | approved no-update message at 2 h, no repair claims |
| F ETA | ETA template with site and local time |
| G Restoration | stability period, downtime, awaiting RFO, schedule stopped |
| H RFO | final message, resolved only after delivery |
| I Monthly report | every figure checked against the events created; PDF/XLSX/CSV produced; empty period → no fabricated findings |

## Edge cases (`tests/edge-cases.test.ts`)

| # | Case | Defined outcome |
|---|---|---|
| 1 | Down & up within 3 min | `interruption`, no external messages, downtime kept |
| 2 | Down > 3 min | validated, initial message |
| 3 | Duplicate notifications | duplicate rejected by dedupe key; same-state events ignored; one incident |
| 4 | Delayed restoration | downtime uses the event's own timestamp |
| 5 | UP before DOWN | reconstructed interruption, no messages |
| 6 | Integration disconnects | critical "NetXMS silent" alert, cleared by heartbeat |
| 7 | Many sites at once | independent incidents, references and schedules |
| 8 | Shared backhaul | correlation suggestion; grouped update |
| 9 | Wrong cause corrected | audit, unsent message cancelled, corrected wording sent, periodic follows correction |
| 10 | No ETA | ETA-free template |
| 11 | ETA changes / passes | *ETA changed*; past ETA never quoted; Technical escalated |
| 12 | Contradictory update | flagged, not pre-filled, send blocked until acknowledged; "investigating" ≠ "repairs underway" |
| 13 | No tech update > 2 h | awaiting-backhaul message continues; L1/L2 escalation |
| 14 | Provider fails | deferred + retried + alerted; permanent failure → failed + escalated |
| 15 | Accepted then bounced | status updated, contact invalid after threshold, alert, message partially failed |
| 16 | Restart mid-job | lease expiry → re-run → no duplicate; dead-letter after max attempts |
| 17 | Flap during restoration | no restoration message, flap counted, continuous downtime; repeat after restore → linked new incident |
| 18 | Restored while update queued | periodic deferred; queued update cancelled at send time |
| 19 | RFO days later | accepted; overdue escalations raised then cleared |
| 20 | Template edited while queued | queued message keeps the wording it was rendered with; unapproved wording never sent; self-approval blocked |
| 21 | Wrong site / stale action | stale version rejected; closed incident rejected; only the incident's own recipients targeted |
| 22 | One ISP, several sites | one copy per contact in grouped updates |
| 23 | After hours | identical automation; business-hours rules wait |
| 24 | Dispatch unacknowledged | escalated; duplicate dispatch prevented |
| 25 | Simultaneous updates | exactly one succeeds, one conflict, one cause message |

Plus: interface events, unmatched objects, Telegram backup parsing, audit append-only + hash chain, renderer strictness, extraction negation/ambiguity, bounce classification, ingestion auth.

## UI checks

Screens were exercised in headless Chrome against a seeded demo database (`npm run demo:seed`): Service Desk cause confirmation end to end, technical update analysis, admin, reports, handover, mobile layout.
