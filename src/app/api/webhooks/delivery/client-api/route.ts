import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { applyDeliveryStatus } from "@/server/comms/delivery-status";
import { requireHmac } from "@/server/ingestion/auth";
import { errorResponse } from "@/server/api";

const Body = z.object({
  delivery_id: z.string().uuid().optional(), message_id: z.string().max(300).optional(),
  status: z.enum(["delivered", "bounced", "deferred", "failed"]), detail: z.string().max(1000).optional(), hard: z.boolean().optional(),
});
/** Delivery status callbacks from the client communications API (HMAC-SHA256 of the raw body). */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    requireHmac(req, raw, "CLIENT_API_WEBHOOK_SECRET");
    const b = Body.parse(JSON.parse(raw));
    const found = await applyDeliveryStatus(getDb(), { deliveryId: b.delivery_id, providerMessageId: b.message_id, status: b.status, detail: b.detail, hard: b.hard, raw: b });
    return NextResponse.json({ ok: true, found });
  } catch (e) { return errorResponse(e); }
}
