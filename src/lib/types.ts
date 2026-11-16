import type { IncidentDetail } from "@/server/queries";
/** Shape of server data after JSON transport (Dates become strings). */
export type Jsonify<T> = T extends Date ? string : T extends (infer U)[] ? Jsonify<U>[] : T extends object ? { [K in keyof T]: Jsonify<T[K]> } : T;
export type Detail = Jsonify<IncidentDetail>;
export type Role = "service_desk" | "technical" | "admin";
