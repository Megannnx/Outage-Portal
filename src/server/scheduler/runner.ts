/**
 * Executes due jobs. Used by the worker process and by tests (with a controlled clock).
 */
import { sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { claimDue, completeJob, failJob, type ClaimedJob } from "./jobs";
import { runValidateOutage, runVerifyRestoration, runPeriodicUpdate } from "../incidents/lifecycle";
import { deliverCommunication } from "../comms/engine";
import { runInternalNotify, type InternalMessage } from "../comms/internal";
import { raiseAlert } from "../lib/alerts";

export async function executeJob(db: DB, job: ClaimedJob) {
  const p = job.payload as Record<string, string>;
  switch (job.kind) {
    case "validate_outage": return runValidateOutage(db, p.incidentId);
    case "verify_restoration": return runVerifyRestoration(db, p.incidentId, p.upAt);
    case "periodic_update": return runPeriodicUpdate(db, job.incident_id!, p.dueAt);
    case "deliver_communication": return deliverCommunication(db, p.communicationId);
    case "internal_notify": return runInternalNotify(db, job.payload as unknown as InternalMessage);
    default: throw new Error(`Unknown job kind ${job.kind}`);
  }
}

export async function runDueJobs(db: DB, workerId: string, batch = 20): Promise<number> {
  const claimed = await claimDue(db, workerId, batch);
  for (const job of claimed) {
    try {
      await executeJob(db, job);
      await completeJob(db, job.id);
    } catch (e) {
      const outcome = await failJob(db, job, e);
      console.error(`[worker] job ${job.id} ${job.kind} failed (${outcome}):`, (e as Error).message);
      if (outcome === "dead") await raiseAlert(db, `dead_job:${job.id}`, "critical", `Job ${job.kind} #${job.id} failed permanently: ${(e as Error).message}`, job.incident_id);
    }
  }
  return claimed.length;
}

/** Run until no job is due (tests / catch-up after downtime). */
export async function drain(db: DB, workerId = "drain", maxRounds = 50) {
  let total = 0;
  for (let i = 0; i < maxRounds; i++) {
    const n = await runDueJobs(db, workerId);
    total += n;
    if (!n) break;
  }
  return total;
}

/**
 * Run fn on at most one worker/tick at a time, using a short lease row instead of a
 * session advisory lock (session locks are unsafe behind a transaction pooler).
 */
export async function withSweepLock<T>(db: DB, fn: () => Promise<T>, leaseSeconds = 25): Promise<T | null> {
  const r = await db.execute(sql`
    insert into integration_health (key, label, last_success_at) values ('sweep_lease', 'Sweep lease', now())
    on conflict (key) do update set last_success_at = now()
      where integration_health.last_success_at is null or integration_health.last_success_at < now() - make_interval(secs => ${leaseSeconds})
    returning key`);
  if (!r.rows.length) return null;
  return fn();
}
