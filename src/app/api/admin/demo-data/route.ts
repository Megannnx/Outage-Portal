import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { removeDemoData } from "@/server/admin/demo-cleanup";
export const maxDuration = 60;
export const DELETE = route({ perm: "admin.config", body: z.object({ confirm: z.literal("REMOVE DEMO DATA") }) }, async ({ actor }) => removeDemoData(getDb(), actor));
