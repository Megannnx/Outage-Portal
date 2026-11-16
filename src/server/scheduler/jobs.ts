/**
 * Durable, Postgres-backed job queue.
 *
 * Why not Redis/BullMQ: every job here is tied to incident state that already
 * lives in Postgres. Keeping jobs in the same database means a job and the state
 * change that created it commit (or roll back) together — no "email scheduled
 * for an incident that was never saved", and nothing to lose if Redis restarts.
 *
 *  - Claiming uses FOR UPDATE SKIP LOCKED, so any number of workers can run.
 *  - A claimed job holds a lease; if the worker dies the lease expires and the
 *    job is picked up again (handlers are idempotent).
 *  - dedupe_key + a partial unique index stops two identical pending jobs.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { jobs } from "../db/schema";
import { clock, addMinutes } from "../lib/clock";

export type JobKind = "validate_outage" | "verify_restoration" | "periodic_update" | "deliver_communication" | "internal_notify";

export interface EnqueueInput {
  kind: JobKind;
  runAt: Date;
  incidentId?: string | null;
  dedupeKey?: string | null;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export async function enqueue(db: Tx, j: EnqueueInput): Promise<number | null> {
  const res = await db.execute(sql`
    insert into jobs (kind, incident_id, run_at, dedupe_key, payload, max_attempts, status)
    values (${j.kind}, ${j.incidentId ?? null}, ${j.runAt.toISOString()}, ${j.dedupeKey ?? null},
            ${JSON.stringify(j.payload ?? {})}::jsonb, ${j.maxAttempts ?? 8}, 'pending')
    on conflict (dedupe_key) where dedupe_key is not null and status in ('pending','running') do nothing
    returning id`);
  return (res.rows[0] as { id: number } | undefined)?.id ?? null;
}

export async function cancelJobs(db: Tx, incidentId: string, kinds: JobKind[]) {
  await db.update(jobs).set({ status: "cancelled", completedAt: clock.now() })
    .where(and(eq(jobs.incidentId, incidentId), inArray(jobs.kind, kinds), eq(jobs.status, "pending")));
}

export interface ClaimedJob {
  id: number; kind: JobKind; incident_id: string | null; payload: Record<string, unknown>;
  attempts: number; max_attempts: number; run_at: Date;
}

const LEASE_MINUTES = 5;

export async function claimDue(db: Tx, workerId: string, limit = 20): Promise<ClaimedJob[]> {
  const now = clock.now();
  const res = await db.execute(sql`
    update jobs set status = 'running', locked_by = ${workerId},
      locked_until = ${addMinutes(now, LEASE_MINUTES).toISOString()}, attempts = attempts + 1
    where id in (
      select id from jobs
      where (status = 'pending' and run_at <= ${now.toISOString()})
         or (status = 'running' and locked_until < ${now.toISOString()})
      order by run_at
      for update skip locked
      limit ${limit})
    returning id, kind, incident_id, payload, attempts, max_attempts, run_at`);
  // UPDATE … RETURNING has no guaranteed order: run strictly in due order.
  return (res.rows as unknown as ClaimedJob[]).sort((a, b) => new Date(a.run_at).getTime() - new Date(b.run_at).getTime() || a.id - b.id);
}

export async function completeJob(db: Tx, id: number) {
  await db.update(jobs).set({ status: "done", completedAt: clock.now(), lockedBy: null, lockedUntil: null }).where(eq(jobs.id, id));
}

/** Retry with exponential backoff, or move to the dead-letter state. */
export async function failJob(db: Tx, job: ClaimedJob, err: unknown): Promise<"retry" | "dead"> {
  const msg = err instanceof Error ? `${err.message}` : String(err);
  if (job.attempts >= job.max_attempts) {
    await db.update(jobs).set({ status: "dead", lastError: msg.slice(0, 2000), completedAt: clock.now(), lockedBy: null, lockedUntil: null }).where(eq(jobs.id, job.id));
    return "dead";
  }
  const backoffMin = Math.min(30, 2 ** (job.attempts - 1) * 0.5);
  await db.update(jobs).set({
    status: "pending", lastError: msg.slice(0, 2000), lockedBy: null, lockedUntil: null,
    runAt: addMinutes(clock.now(), backoffMin),
  }).where(eq(jobs.id, job.id));
  return "retry";
}
