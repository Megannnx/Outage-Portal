import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { createResource, listResource } from "@/server/admin/resources";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "admin.config" }, async ({ params }) => ({ items: await listResource(getDb(), params.resource) }));
export const POST = route({ perm: "admin.config" }, async ({ params, req, actor, user }) => {
  if (params.resource === "users" && user.role !== "admin") throw new Error("forbidden");
  return createResource(getDb(), actor, params.resource, await req.json());
});
