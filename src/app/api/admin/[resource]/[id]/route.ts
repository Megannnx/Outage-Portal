import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { deleteResource, updateResource } from "@/server/admin/resources";
export const PATCH = route({ perm: "admin.config" }, async ({ params, req, actor }) => updateResource(getDb(), actor, params.resource, decodeURIComponent(params.id), await req.json()));
export const DELETE = route({ perm: "admin.config" }, async ({ params, actor }) => deleteResource(getDb(), actor, params.resource, decodeURIComponent(params.id)));
