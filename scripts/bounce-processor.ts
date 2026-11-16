/**
 * Bounce-mailbox processor for SMTP sends (ISPs).
 *
 * SMTP relays only say "accepted". Real failures come back later as bounce
 * emails (DSNs) to the envelope sender. Point SMTP_FROM / the return-path at a
 * mailbox this script can read, run it every few minutes (cron/systemd timer or
 * the `bounces` compose service), and it posts each bounce to the portal's
 * /api/webhooks/delivery/smtp endpoint, matched on our per-delivery Message-ID.
 *
 * Env: BOUNCE_IMAP_HOST, BOUNCE_IMAP_PORT (993), BOUNCE_IMAP_USER, BOUNCE_IMAP_PASSWORD,
 *      PORTAL_URL (default http://web:3000), BOUNCE_WEBHOOK_TOKEN, SMTP_MESSAGE_ID_DOMAIN
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const domain = process.env.SMTP_MESSAGE_ID_DOMAIN ?? "outages.atec.local";
const idRe = new RegExp(`<([0-9a-f-]{36})@${domain.replace(/\./g, "\\.")}>`, "i");

export function classify(raw: string): { messageId: string | null; hard: boolean; status: string; detail: string } {
  const id = raw.match(idRe);
  const statusMatch = raw.match(/^Status:\s*([245])\.(\d{1,3})\.(\d{1,3})/im);
  const action = raw.match(/^Action:\s*(\w+)/im)?.[1]?.toLowerCase() ?? "";
  const diag = raw.match(/^Diagnostic-Code:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const cls = statusMatch?.[1];
  const hard = cls === "5" || action === "failed";
  const status = action === "delivered" || cls === "2" ? "delivered" : action === "delayed" || cls === "4" ? "deferred" : "bounced";
  return { messageId: id ? `<${id[1]}@${domain}>` : null, hard, status, detail: (diag || (statusMatch ? statusMatch[0] : "Bounce")).slice(0, 500) };
}

async function main() {
  const client = new ImapFlow({
    host: process.env.BOUNCE_IMAP_HOST!, port: Number(process.env.BOUNCE_IMAP_PORT ?? 993), secure: true,
    auth: { user: process.env.BOUNCE_IMAP_USER!, pass: process.env.BOUNCE_IMAP_PASSWORD! }, logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  let posted = 0, skipped = 0;
  try {
    for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
      const raw = msg.source?.toString("utf8") ?? "";
      const parsed = await simpleParser(raw);
      const r = classify(raw + "\n" + (parsed.text ?? ""));
      if (!r.messageId) { skipped++; continue; } // not one of ours — leave it unread for a human
      const res = await fetch(`${process.env.PORTAL_URL ?? "http://web:3000"}/api/webhooks/delivery/smtp`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.BOUNCE_WEBHOOK_TOKEN}` },
        body: JSON.stringify({ message_id: r.messageId, status: r.status, detail: r.detail, hard: r.hard }),
      });
      if (res.ok) { await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], { uid: true }); posted++; }
      else console.error(`[bounces] portal rejected ${r.messageId}: ${res.status}`);
    }
  } finally { lock.release(); await client.logout(); }
  console.log(`[bounces] processed ${posted}, ignored ${skipped} non-portal messages`);
}
if (process.argv[1]?.includes("bounce-processor")) main().catch((e) => { console.error(e); process.exit(1); });
