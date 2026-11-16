export type Role = "service_desk" | "technical" | "admin";

export const PERMISSIONS = {
  "incident.view": ["service_desk", "technical", "admin"],
  "incident.confirm_cause": ["service_desk", "admin"],
  "incident.technical_update": ["technical", "admin"],
  "incident.rfo": ["technical", "admin"],
  "incident.rfo_waive": ["admin"],
  "dispatch.create": ["service_desk", "technical", "admin"],
  "dispatch.update": ["technical", "admin", "service_desk"],
  "correlation.decide": ["technical", "admin"],
  "reports.view": ["admin"],
  "admin.templates": ["admin"],
  "admin.config": ["admin"],
  "admin.users": ["admin"],
  "admin.audit": ["admin"],
} as const satisfies Record<string, Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | undefined | null, p: Permission): boolean {
  return !!role && (PERMISSIONS[p] as readonly Role[]).includes(role);
}
export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
