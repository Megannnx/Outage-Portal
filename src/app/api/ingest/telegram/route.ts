import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { getSettings } from "@/server/domain/settings";
import { fromTelegram } from "@/server/ingestion/normalize";
import { processEvent } from "@/server/incidents/lifecycle";
import { safeEqual } from "@/server/lib/crypto";
import { errorResponse } from "@/server/api";

/**
 * Telegram Bot API webhook (BACKUP path). Register with setWebhook + secret_token;
 * Telegram echoes it in X-Telegram-Bot-Api-Secret-Token. The portal's bot must be an
 * admin of the private channel that NetXMS posts to (bots cannot read other bots in groups).
 */
export async function POST(req: NextRequest) {
  try {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected) return NextResponse.json({ error: "not_configured" }, { status: 503 });
    if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", expected)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const allowedChats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const update = await req.json();
    const chatId = String(update?.channel_post?.chat?.id ?? update?.message?.chat?.id ?? "");
    if (allowedChats.length && !allowedChats.includes(chatId)) return NextResponse.json({ ok: true, ignored: "chat" });
    const db = getDb();
    const ev = fromTelegram(update, await getSettings(db));
    if (!ev) return NextResponse.json({ ok: true, ignored: "no_text" });
    const r = await processEvent(db, ev);
    return NextResponse.json({ ok: true, ...r }); // always 200 so Telegram does not retry-storm
  } catch (e) { return errorResponse(e); }
}
