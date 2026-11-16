import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { exportSitesWorkbook, importSitesWorkbook } from "@/server/admin/site-import";
import { badRequest } from "@/server/lib/errors";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Download all (non-demo) sites in the editable spreadsheet layout. */
export const GET = route({ perm: "admin.config" }, async () => {
  const buf = await exportSitesWorkbook(getDb());
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(buf), { headers: {
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": `attachment; filename="ATEC-portal-sites-${stamp}.xlsx"`,
  } });
});

/** Upload the workbook. ?apply=1 commits; otherwise returns a preview of every change. */
export const POST = route({ perm: "admin.config" }, async ({ req, actor }) => {
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) throw badRequest("No file received");
  if (buf.length > 5 * 1024 * 1024) throw badRequest("File is larger than 5 MB");
  return importSitesWorkbook(getDb(), actor, buf, new URL(req.url).searchParams.get("apply") === "1");
});
