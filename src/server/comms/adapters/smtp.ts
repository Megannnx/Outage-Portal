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

let transporter: Transporter | null = null;

function cfg() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM,
    replyTo: process.env.SMTP_REPLY_TO,
    msgIdDomain: process.env.SMTP_MESSAGE_ID_DOMAIN ?? "outages.atec.local",
  };
}

export const smtpAdapter: DeliveryAdapter = {
  channel: "smtp",
  isCapture: false,
  configError() {
    const c = cfg();
    if (!c.host) return "SMTP_HOST is not set";
    if (!c.from) return "SMTP_FROM is not set";
    return null;
  },
  async send(msg: OutboundMessage): Promise<SendResult> {
    const c = cfg();
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host: c.host, port: c.port, secure: c.secure,
        auth: c.user ? { user: c.user, pass: c.pass } : undefined,
        requireTLS: !c.secure && process.env.SMTP_REQUIRE_TLS !== "false",
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      });
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
