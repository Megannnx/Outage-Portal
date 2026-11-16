import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { readiness } from "@/server/admin/readiness";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "admin.config" }, async () => readiness(getDb()));
