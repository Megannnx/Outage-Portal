import { sql } from "drizzle-orm";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
export const dynamic = "force-dynamic";
/** Recipient data-quality view: invalid/suppressed, bouncing, duplicates, ISPs without working contacts. */
export const GET = route({ perm: "admin.config" }, async () => {
  const db = getDb();
  const [problem, dupes, ispsNoContact, ispFailures, sitesNoIsp] = await Promise.all([
    db.execute(sql`select r.*, i.name as isp_name from recipients r left join isps i on i.id = r.isp_id where r.status <> 'active' or r.bounce_count > 0 order by r.status desc, r.bounce_count desc`),
    db.execute(sql`select lower(email) as email, count(*)::int as n, array_agg(audience) as audiences from recipients group by lower(email) having count(*) > 1`),
    db.execute(sql`select i.id, i.name from isps i where i.active and not exists (select 1 from recipients r where r.isp_id = i.id and r.status = 'active')`),
    db.execute(sql`select i.name, d.address, count(*) filter (where d.status in ('failed','bounced'))::int as failed, count(*)::int as total, max(d.updated_at) as last
      from communication_deliveries d join isps i on i.id = d.isp_id where d.updated_at > now() - interval '60 days' group by i.name, d.address having count(*) filter (where d.status in ('failed','bounced')) > 0 order by failed desc`),
    db.execute(sql`select s.id, s.code, s.name from sites s where s.active and not exists (select 1 from site_isps x where x.site_id = s.id)`),
  ]);
  return { problem: problem.rows, duplicates: dupes.rows, ispsWithoutContacts: ispsNoContact.rows, ispFailures: ispFailures.rows, sitesWithoutIsps: sitesNoIsp.rows };
});
