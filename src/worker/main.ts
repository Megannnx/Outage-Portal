/**
 * Background worker — the part of the system that keeps working when nobody is logged in.
 * Run one or more replicas; they coordinate through Postgres (SKIP LOCKED + advisory locks).
 */
import os from "node:os";
import { getDb, getPool } from "../server/db/client";
import { runMigrations } from "../server/db/migrate";
import { runDueJobs, withSweepLock } from "../server/scheduler/runner";
import { runEscalationSweep, runHealthSweep } from "../server/escalations/engine";
import { healthOk } from "../server/lib/alerts";
import { deliveryMode } from "../server/comms/adapters";

const workerId = `${os.hostname()}:${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);
const SWEEP_MS = Number(process.env.WORKER_SWEEP_MS ?? 30000);
let stopping = false;

async function main() {
  if (process.env.RUN_MIGRATIONS_ON_START !== "false") await runMigrations();
  const db = getDb();
  console.log(`[worker] ${workerId} started — delivery mode: ${deliveryMode().toUpperCase()}`);
  let lastSweep = 0;
  while (!stopping) {
    try {
      const n = await runDueJobs(db, workerId);
      if (Date.now() - lastSweep > SWEEP_MS) {
        lastSweep = Date.now();
        await withSweepLock(db, async () => { await runEscalationSweep(db); await runHealthSweep(db); });
        await healthOk(db, "worker", "Background worker", { workerId, deliveryMode: deliveryMode() });
      }
      if (n === 0) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (e) {
      console.error("[worker] loop error", e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await getPool().end();
  console.log("[worker] stopped");
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopping = true; });
main().catch((e) => { console.error(e); process.exit(1); });
