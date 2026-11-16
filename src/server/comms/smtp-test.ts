/**
 * Send a real test email through one network's SMTP account. Works in capture
 * mode too (it bypasses the capture adapter on purpose) so the mail accounts can
 * be proven before going live. Used by Admin › System and by the `smtp_test` job.
 */
import { z } from "zod";
import type { Tx } from "../db/client";
import { smtpAdapter, smtpProfile } from "./adapters/smtp";
import { audit, type Actor } from "../audit/audit";
import { healthOk, healthError } from "../lib/alerts";
import { badRequest } from "../lib/errors";
import { getSettings } from "../domain/settings";
import { clock } from "../lib/clock";
import { fmtDateTime } from "../lib/time";

export const SmtpTestSchema = z.object({ network: z.string().trim().toUpperCase().max(20).default(""), to: z.string().trim().email("Enter a valid email address") });

export async function sendSmtpTest(db: Tx, actor: Actor, input: z.input<typeof SmtpTestSchema>) {
  const { network, to } = SmtpTestSchema.parse(input);
  const cfgErr = smtpAdapter.configError(network);
  if (cfgErr) throw badRequest(`Email for ${network || "default"} is not configured: ${cfgErr}`);
  const p = smtpProfile(network);
  const settings = await getSettings(db);
  const support = settings.supportContactByNetwork[network]?.trim() || settings.supportContact;
  const now = clock.now();
  const subject = `Test email – ${network || "ATEC"} outage notifications`;
  const text = `Hello,\n\nThis is a test email from the ATEC outage communications portal.\n\nIt was sent from the ${network || "default"} mailbox (${p.from}) at ${fmtDateTime(now)}. ISP outage notices for ${network || "these"} sites will arrive from this address in this format.\n\nNo action is needed.\n\nReference: TEST\n${support}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>`;
  const label = `SMTP ${network || "default"} (${p.from})`;
  try {
    const r = await smtpAdapter.send({ deliveryId: `test-${now.getTime()}-${network.toLowerCase() || "default"}`, address: to, subject, text, html,
      meta: { incidentReference: "TEST", siteCode: "TEST", audience: "isp", kind: "smtp_test", network } });
    await healthOk(db, `delivery:smtp:${p.key}`, label);
    await audit(db, actor, "smtp.test_sent", "smtp", p.key, null, { to, from: p.from, host: p.host });
    return { ok: true, network: p.network, from: p.from, host: p.host, to, messageId: r.providerMessageId };
  } catch (e) {
    await healthError(db, `delivery:smtp:${p.key}`, label, (e as Error).message);
    await audit(db, actor, "smtp.test_failed", "smtp", p.key, null, { to, from: p.from, host: p.host, error: (e as Error).message });
    throw badRequest(`Sending from ${p.from} via ${p.host} failed: ${(e as Error).message}`);
  }
}
