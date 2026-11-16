import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { sendSmtpTest, SmtpTestSchema } from "@/server/comms/smtp-test";
export const dynamic = "force-dynamic";
export const POST = route({ perm: "admin.config", body: SmtpTestSchema }, async ({ body, actor }) => sendSmtpTest(getDb(), actor, body));
