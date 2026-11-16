/**
 * SMTP adapter — ISP outage notices and internal notifications.
 * Every recipient gets an individual message (no shared To/CC), so one ISP can
 * never see another ISP's addresses.
 *
 * SMTP only tells us the relay ACCEPTED the message. Delivery/bounce status
 * arrives later through the bounce webhook (see /api/webhooks/delivery/smtp).
 */
import nodemailer, { type Transporter } from "nodemailer";
import { DeliveryError, type DeliveryAdapter, type OutboundMessage, type SendResult } from "./types";

const transporters = new Map<string, Transporter>();

/**
 * Each network sends from its own mailbox (e.g. FSN → noreply@fibresuburb.co.za,
 * FMAS → noreply@fmas.co.za). SMTP_<NETWORK>_* overrides the shared SMTP_* value,
 * so a shared host/port only needs to be set once. Internal mail and sites with
 * no network use the shared SMTP_* account, or the first network account if
 * there is no shared one.
 */
export function smtpNetworks(): string[] {
  return [...new Set(Object.keys(process.env).map((k) => /^SMTP_([A-Z0-9]+)_(USER|FROM)$/.exec(k)?.[1]).filter((x): x is string => !!x))].sort();
}

export function smtpProfile(network?: string) {
  const e = process.env;
  let net = (network ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!net || !(e[`SMTP_${net}_USER`] || e[`SMTP_${net}_FROM`])) net = e.SMTP_USER || e.SMTP_FROM ? "" : smtpNetworks()[0] ?? "";
  const v = (k: string) => (net && e[`SMTP_${net}_${k}`]) || e[`SMTP_${k}`];
  const from = v("FROM") ?? v("USER");
  return {
    key: net || "default", network: net || null,
    host: v("HOST"), port: Number(v("PORT") ?? 587), secure: v("SECURE") === "true", requireTls: v("REQUIRE_TLS") !== "false",
    user: v("USER"), pass: v("PASSWORD"), from, replyTo: v("REPLY_TO"),
    msgIdDomain: v("MESSAGE_ID_DOMAIN") ?? /@([^>\s]+)/.exec(from ?? "")?.[1] ?? "outages.atec.local",
  };
}

export const smtpAdapter: DeliveryAdapter = {
  channel: "smtp",
  isCapture: false,
  configError(network?: string) {
    const c = smtpProfile(network);
    const label = c.network ? `SMTP_${c.network}_` : "SMTP_";
    if (!c.host) return `${label}HOST (or SMTP_HOST) is not set`;
    if (!c.from) return `${label}FROM / ${label}USER is not set`;
    if (c.user && !c.pass) return `${label}PASSWORD is not set`;
    return null;
  },
  async send(msg: OutboundMessage): Promise<SendResult> {
    const c = smtpProfile(msg.meta.network);
    let transporter = transporters.get(c.key);
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host: c.host, port: c.port, secure: c.secure,
        auth: c.user ? { user: c.user, pass: c.pass } : undefined,
        requireTLS: !c.secure && c.requireTls,
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      });
      transporters.set(c.key, transporter);
    }
    // Deterministic Message-ID: a retry after a crash re-uses it, so receiving
    // systems that de-duplicate on Message-ID will drop the second copy.
    const messageId = `<${msg.deliveryId}@${c.msgIdDomain}>`;
    try {
      const info = await transporter.sendMail({
        from: c.from, to: msg.address, replyTo: c.replyTo || undefined,
        subject: msg.subject, text: msg.text, html: msg.html, messageId,
        headers: {
          "X-ATEC-Incident": msg.meta.incidentReference,
          "X-ATEC-Delivery": msg.deliveryId,
          "Auto-Submitted": "auto-generated",
        },
      });
      if (info.rejected?.length) throw new DeliveryError(`Rejected by relay: ${info.response}`, false, "rejected");
      return { status: "accepted", providerMessageId: messageId };
    } catch (e) {
      if (e instanceof DeliveryError) throw e;
      const err = e as { responseCode?: number; code?: string; message: string };
      // 5xx = permanent (bad mailbox, policy); 4xx / network = transient.
      const permanent = typeof err.responseCode === "number" && err.responseCode >= 500;
      throw new DeliveryError(err.message, !permanent, err.code ?? "smtp_error");
    }
  },
};
