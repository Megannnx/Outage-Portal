/**
 * Remove everything created for demo/testing before go-live:
 *  - demo sites (code DEMO-*), their incidents and all incident history
 *  - simulator-only incidents on real sites (every event was simulated)
 *  - demo ISPs and *.invalid contacts
 *  - wording auto-approved by the demo setup goes back to "pending approval"
 * The audit log is kept (it records this clean-up).
 */
import { sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { audit, type Actor } from "../audit/audit";

export async function removeDemoData(db: DB, actor: Actor) {
  return db.transaction(async (tx) => {
    const q = async (s: ReturnType<typeof sql>) => (await tx.execute(s)).rowCount ?? 0;
    // Incidents to remove: on demo sites, or whose monitoring events were all simulated.
    await tx.execute(sql`create temporary table demo_inc on commit drop as
      select i.id from incidents i join sites s on s.id = i.site_id where s.code like 'DEMO-%'
      union
      select i.id from incidents i where exists (select 1 from monitoring_events e where e.incident_id = i.id)
        and not exists (select 1 from monitoring_events e where e.incident_id = i.id and e.raw->>'simulated' is null)`);
    const incidents = Number(((await tx.execute(sql`select count(*) as n from demo_inc`)).rows[0] as { n: string }).n);

    // Technical notes are protected against deletion; lift that only for this transaction.
    await tx.execute(sql`alter table technical_updates disable trigger technical_updates_no_delete`);
    await q(sql`delete from delivery_events where delivery_id in (select d.id from communication_deliveries d join communications c on c.id = d.communication_id where c.incident_id in (select id from demo_inc))`);
    await q(sql`delete from communication_deliveries where communication_id in (select id from communications where incident_id in (select id from demo_inc))`);
    for (const t of ["communications", "communication_schedules", "escalations", "rfo_records", "technician_dispatches", "technical_updates", "cause_confirmations", "timeline_entries", "incident_transitions"])
      await q(sql.raw(`delete from ${t} where incident_id in (select id from demo_inc)`));
    await q(sql`delete from jobs where incident_id in (select id from demo_inc)`);
    await q(sql`delete from system_alerts where incident_id in (select id from demo_inc)`);
    await q(sql`delete from correlation_suggestions where incident_ids && (select coalesce(array_agg(id), '{}') from demo_inc)`);
    await q(sql`update monitoring_events set incident_id = null where incident_id in (select id from demo_inc)`);
    await q(sql`update incidents set related_incident_id = null where related_incident_id in (select id from demo_inc)`);
    await q(sql`delete from incidents where id in (select id from demo_inc)`);
    await tx.execute(sql`alter table technical_updates enable trigger technical_updates_no_delete`);
    await q(sql`delete from incident_groups g where not exists (select 1 from incidents i where i.group_id = g.id)`);

    await q(sql`delete from monitoring_events where site_id in (select id from sites where code like 'DEMO-%')`);
    const sites = await q(sql`delete from sites where code like 'DEMO-%'`);
    await q(sql`delete from monitoring_events where raw->>'simulated' = 'true'`);
    const isps = await q(sql`delete from isps where name like '%(DEMO)' or name like 'Demo ISP%'`);
    const contacts = await q(sql`delete from recipients where email like '%.invalid'`);
    const templates = await q(sql`update template_versions tv set status = 'pending_approval', published_at = null
      where tv.status = 'published' and exists (select 1 from template_approvals a where a.template_version_id = tv.id and a.comment ~* '(Demo setup|Seeded for demo)')`);
    await q(sql`delete from system_alerts where resolved_at is null and (message like '%(DEMO)%' or key like 'unmatched:%')`);

    const summary = { incidents, sites, isps, contacts, templatesBackToPending: templates };
    await audit(tx, actor, "demo_data.removed", "system", "demo", null, summary);
    return summary;
  });
}
