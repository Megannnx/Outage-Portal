/**
 * Capture adapter — DEVELOPMENT / DEMO ONLY.
 * Records the message instead of sending it. The UI shows a permanent red
 * "CAPTURE MODE — nothing is being sent" banner whenever this is active, so it
 * can never be mistaken for a live connection.
 */
import { DeliveryError, type DeliveryAdapter, type OutboundMessage, type SendResult } from "./types";

export const captured: OutboundMessage[] = [];
/** Tests can make the next N sends fail. */
export const captureControl = { failNext: 0, transient: true };

export function captureAdapter(channel: "client_api" | "smtp"): DeliveryAdapter {
  return {
    channel,
    isCapture: true,
    configError: () => null,
    async send(msg: OutboundMessage): Promise<SendResult> {
      if (captureControl.failNext > 0) {
        captureControl.failNext--;
        throw new DeliveryError("Simulated provider failure (capture mode)", captureControl.transient, "simulated");
      }
      captured.push(msg);
      return { status: "accepted", providerMessageId: `capture:${msg.deliveryId}` };
    },
  };
}
