/**
 * Server-Sent Events change feed. Each connection polls a cheap fingerprint of
 * operational state every 3 s and pushes "changed" when it moves; clients then
 * refetch. Survives proxies, needs no extra infrastructure.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { requireUser } from "@/server/auth/session";
import { errorResponse } from "@/server/api";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(req: Request) {
  try { await requireUser("incident.view"); } catch (e) { return errorResponse(e); }
  const db = getDb();
  let last = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: string) => { try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`)); } catch { /* closed */ } };
      const check = async () => {
        try {
          const r = await db.execute(sql`select
            (select coalesce(max(updated_at)::text,'') from incidents) || '|' ||
            (select coalesce(max(id),0)::text from timeline_entries) || '|' ||
            (select count(*)::text from system_alerts where resolved_at is null) || '|' ||
            (select coalesce(max(updated_at)::text,'') from communication_deliveries) as fp`);
          const fp = (r.rows[0] as { fp: string }).fp;
          if (fp !== last) { last = fp; send("changed", JSON.stringify({ at: Date.now() })); }
          else send("ping", "1");
        } catch { send("error", "db"); }
      };
      void check();
      timer = setInterval(check, 3000);
      // Serverless functions have a time limit: close cleanly and let EventSource reconnect.
      setTimeout(() => { clearInterval(timer); try { controller.enqueue(enc.encode("retry: 1000\n\n")); controller.close(); } catch { /* */ } }, Number(process.env.SSE_MAX_SECONDS ?? (process.env.VERCEL ? 50 : 3600)) * 1000);
      req.signal.addEventListener("abort", () => { clearInterval(timer); try { controller.close(); } catch { /* */ } });
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
