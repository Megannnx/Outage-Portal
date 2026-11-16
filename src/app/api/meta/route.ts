import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { systemMeta } from "@/server/queries";
import { permissionsFor } from "@/server/auth/permissions";
export const dynamic = "force-dynamic";
export const GET = route({}, async ({ user }) => ({ user: { id: user.id, name: user.name, role: user.role, permissions: permissionsFor(user.role) }, ...(await systemMeta(getDb())) }));
