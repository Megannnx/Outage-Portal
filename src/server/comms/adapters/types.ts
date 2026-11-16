export interface OutboundMessage {
  deliveryId: string;
  address: string;          // email address, or list:<ref> for the client API
  subject: string;
  text: string;
  html: string;
  meta: { incidentReference: string; siteCode: string; audience: string; kind: string; network?: string };
}
export interface SendResult { status: "accepted" | "delivered"; providerMessageId?: string }

/** transient=true → retry later (timeouts, 5xx, 429). transient=false → permanent failure. */
export class DeliveryError extends Error {
  constructor(message: string, public transient: boolean, public code = "delivery_error") { super(message); }
}

export interface DeliveryAdapter {
  channel: "client_api" | "smtp";
  /** Human-readable reason when the adapter cannot be used, or null when ready. */
  configError(network?: string): string | null;
  isCapture: boolean;
  send(msg: OutboundMessage): Promise<SendResult>;
}
