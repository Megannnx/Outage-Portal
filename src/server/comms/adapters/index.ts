import { captureAdapter } from "./capture";
import { clientApiAdapter } from "./client-api";
import { smtpAdapter } from "./smtp";
import type { DeliveryAdapter } from "./types";

export function deliveryMode(): "live" | "capture" {
  return process.env.DELIVERY_MODE === "live" ? "live" : "capture";
}
export function getAdapter(channel: "client_api" | "smtp"): DeliveryAdapter {
  if (deliveryMode() === "capture") return captureAdapter(channel);
  return channel === "smtp" ? smtpAdapter : clientApiAdapter;
}
export * from "./types";
