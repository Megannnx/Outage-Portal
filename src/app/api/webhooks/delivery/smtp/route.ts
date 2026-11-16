import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { applyDeliveryStatus } from "@/server/comms/delivery-status";
import { requireBearer } from "@/server/ingestion/auth";
import { errorResponse } from "@/server/api";

/**
 * Bounce / DSN feed for SMTP sends. Fed by the bounce-mailbox processor
 * (scripts/bounce-processor.ts) or an MTA hook. Matching is on the Message-ID
 * we set per delivery: <deliveryId@domain>.
 */
const Body = z.object({ message_id: z.string().max(300), status: z.enum(["delivered", "bounced", "deferred", "failed"]), detail: z.string().max(1000).optional(), hard: z.boolean().optional() });
export async function POST(req: NextRequest) {
  try {
    await requireBearer(req, "bounceWebhook");
    const b = Body.parse(await req.json());
    const id = b.message_id.startsWith("<") ? b.message_id : `<${b.message_id}>`;
    const found = await applyDeliveryStatus(getDb(), { providerMessageId: id, status: b.status, detail: b.detail, hard: b.hard, raw: b });
    return NextResponse.json({ ok: true, found });
  } catch (e) { return errorResponse(e); }
}
