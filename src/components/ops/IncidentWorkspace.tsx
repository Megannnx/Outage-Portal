"use client";
import clsx from "clsx";
import { useApi, useNow, duration, dateTime, humanize } from "@/lib/client";
import type { Detail, Role } from "@/lib/types";
import { Badge, Card, StatusBadge } from "@/components/ui";
import { CausePanel } from "./CausePanel";
import { DispatchPanel } from "./DispatchPanel";
import { TechnicalPanel } from "./TechnicalPanel";
import { RfoPanel } from "./RfoPanel";
import { Timeline } from "./Timeline";
import { CommsPanel } from "./CommsPanel";
import { GroupPanel } from "./GroupPanel";
import { Activity, Wifi, WifiOff } from "lucide-react";

export function IncidentWorkspace({ id, role, onSelect }: { id: string; role: Role; onSelect: (id: string) => void }) {
  const { data, error, reload } = useApi<Detail>(`/api/incidents/${id}`, { live: true });
  const now = useNow(1000);
  if (error) return <div className="p-6 text-primary-bright">{error.message}</div>;
  if (!data) return <div className="p-6 text-ink-muted">Loading incident…</div>;
  const { incident: i, site, provider, schedule } = data;
  const open = ["validating", "active", "restoring"].includes(i.phase);
  const downSec = i.restoredAt ? (new Date(i.restoredAt).getTime() - new Date(i.outageStartedAt).getTime()) / 1000 : (now - new Date(i.outageStartedAt).getTime()) / 1000;
  const nextSec = schedule?.active && schedule.nextDueAt ? (new Date(schedule.nextDueAt).getTime() - now) / 1000 : null;
  const validateSec = i.phase === "validating" ? data.settings.validationMinutes * 60 - downSec : null;
  const canCause = role !== "technical";
  const canTech = role !== "service_desk";

  return (
    <div className="space-y-3 p-3 sm:p-4">
      {/* ── Top bar: incident | site | status | downtime | next communication ── */}
      <div className="sticky top-0 z-10 -mx-3 -mt-3 border-b border-line bg-background/95 px-3 py-3 backdrop-blur sm:-mx-4 sm:-mt-4 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div>
            <div className="font-mono text-2xs text-ink-muted">{i.reference}</div>
            <h1 className="text-[20px] font-extrabold leading-tight">{site.name} <span className="text-[14px] font-medium text-ink-secondary">{site.estate}</span></h1>
          </div>
          <StatusBadge status={i.status} />
          <Stat label={i.restoredAt ? "Total downtime" : "Offline for"} value={duration(downSec)} tone={i.restoredAt ? "green" : "red"} />
          {validateSec != null && <Stat label="Validation" value={validateSec > 0 ? `first message in ${duration(validateSec)}` : "confirming…"} tone="amber" />}
          {nextSec != null && <Stat label="Next customer update" value={nextSec < 0 ? `OVERDUE ${duration(-nextSec)}` : `in ${duration(nextSec)}`} tone={nextSec < 0 ? "red" : undefined} />}
          {!schedule?.active && i.phase !== "validating" && <Stat label="Customer updates" value={i.phase === "awaiting_rfo" ? "Stopped — restored" : "Stopped"} />}
          <div className="ml-auto flex items-center gap-1.5 text-[13px] font-semibold">
            {["restoring", "awaiting_rfo", "resolved", "interruption"].includes(i.phase)
              ? <span className="flex items-center gap-1 text-success"><Wifi size={15} /> Link up{i.phase === "restoring" ? " — checking stability" : ""}</span>
              : <span className="flex items-center gap-1 text-primary-bright"><WifiOff size={15} /> Link down</span>}
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(260px,300px)_minmax(0,1fr)_minmax(320px,400px)] [&>*]:min-w-0">
        {/* ── Left: outage, site, cause, restoration, required action ── */}
        <div className="space-y-3">
          <RequiredAction d={data} role={role} />
          {canCause && open && <CausePanel d={data} onDone={reload} />}
          {!canCause && <Card title="Confirmed cause"><div className="text-[14px] font-semibold">{data.causeOptions.find((c) => c.key === i.causeKey)?.label ?? "Not yet confirmed by Service Desk"}</div></Card>}
          <DispatchPanel d={data} role={role} onDone={reload} />
          <Card title="Outage">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
              <Dt>Went down</Dt><dd className="tabular">{dateTime(i.outageStartedAt)}</dd>
              <Dt>Validated</Dt><dd className="tabular">{i.validatedAt ? dateTime(i.validatedAt) : i.phase === "interruption" ? "No — short interruption" : "Pending"}</dd>
              <Dt>First message</Dt><dd className="tabular">{i.firstCommAt ? dateTime(i.firstCommAt) : "—"}</dd>
              <Dt>Restored</Dt><dd className="tabular">{i.restoredAt ? dateTime(i.restoredAt) : "—"}{i.restorationConfirmedAt && <span className="text-ink-muted"> (stable {dateTime(i.restorationConfirmedAt)})</span>}</dd>
              {i.flapCount > 0 && <><Dt>Flaps</Dt><dd><Badge tone="amber">{i.flapCount}× during restoration</Badge></dd></>}
              <Dt>RFO</Dt><dd>{humanize(i.rfoStatus)}{i.rfoWaiverReason && <span className="block text-2xs text-ink-muted">{i.rfoWaiverReason}</span>}</dd>
              {data.related && <><Dt>Repeat of</Dt><dd><button className="font-mono text-primary-bright underline" onClick={() => onSelect(data.related!.id)}>{data.related.reference}</button></dd></>}
              {i.retrospective && <><Dt>Note</Dt><dd className="text-warning">Processed after the outage ended — no customer messages were sent</dd></>}
            </dl>
          </Card>
          <Card title="Site">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
              <Dt>Code</Dt><dd>{site.code}</dd>
              <Dt>Address</Dt><dd>{site.address || "—"}</dd>
              <Dt>Backhaul</Dt><dd>{provider?.name ?? "—"}</dd>
              <Dt>Circuit</Dt><dd className="font-mono text-[12px]">{site.circuitRef || "—"}</dd>
              <Dt>Upstream</Dt><dd className="font-mono text-[12px]">{site.upstreamRef || "—"}</dd>
              <Dt>Team</Dt><dd>{i.assignedTeam ?? site.technicalTeam}</dd>
              {provider?.supportPhone && <><Dt>Provider NOC</Dt><dd><a className="underline" href={`tel:${provider.supportPhone}`}>{provider.supportPhone}</a></dd></>}
            </dl>
          </Card>
        </div>

        {/* ── Centre: live timeline ── */}
        <div className="min-w-0 space-y-3">
          <GroupPanel d={data} role={role} onSelect={onSelect} onDone={reload} />
          <Timeline d={data} />
        </div>

        {/* ── Right: technical input, RFO, communications, escalations ── */}
        <div className="space-y-3">
          {canTech && open && <TechnicalPanel d={data} onDone={reload} />}
          {i.phase === "awaiting_rfo" && <RfoPanel d={data} role={role} onDone={reload} />}
          <CommsPanel d={data} />
          <Card title={<span className="flex items-center gap-1"><Activity size={13} /> Escalations</span>}>
            {data.escalations.length === 0 ? <div className="text-[13px] text-ink-muted">None</div> : (
              <ul className="space-y-1.5 text-[12.5px]">
                {data.escalations.map((e) => (
                  <li key={e.id} className={clsx("rounded-md border px-2 py-1.5", e.resolvedAt ? "border-line text-ink-muted" : "border-primary-edge bg-primary-tint")}>
                    <div className="font-semibold">L{e.level} · {humanize(e.trigger)}</div>
                    <div>{e.message}</div>
                    <div className="text-2xs text-ink-muted">{dateTime(e.raisedAt)} · notified {(e.notified as string[]).length}{e.resolvedAt ? ` · cleared ${dateTime(e.resolvedAt)}` : ""}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

const Dt = ({ children }: { children: React.ReactNode }) => <dt className="text-ink-muted">{children}</dt>;
function Stat({ label, value, tone }: { label: string; value: string; tone?: "red" | "green" | "amber" }) {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
      <div className={clsx("tabular text-[15px] font-bold", tone === "red" && "text-primary-bright", tone === "green" && "text-success", tone === "amber" && "text-warning")}>{value}</div>
    </div>
  );
}

function RequiredAction({ d, role }: { d: Detail; role: Role }) {
  const i = d.incident;
  const cause = d.causeOptions.find((c) => c.key === i.causeKey);
  const openDispatch = d.dispatches.find((x) => !["cancelled", "completed"].includes(x.status));
  let msg: { text: string; tone: "urgent" | "normal" | "ok" } = { text: "No action needed — customer updates are automatic.", tone: "ok" };
  if (i.phase === "validating") msg = { text: "Validating. If the site is still down after the validation period, the first customer message goes out automatically. You can already confirm the cause.", tone: "normal" };
  else if (i.phase === "active" && !i.causeKey && role !== "technical") msg = { text: "Confirm the cause of this outage.", tone: "urgent" };
  else if (cause?.requiresDispatch && !openDispatch && i.phase === "active") msg = { text: "URGENT: LOG A TECHNICIAN TO INVESTIGATE ON SITE", tone: "urgent" };
  else if (openDispatch && ["requested", "sent"].includes(openDispatch.status)) msg = { text: `Dispatch ${openDispatch.reference} is waiting for a technician to acknowledge.`, tone: "normal" };
  else if (i.phase === "active" && i.technicalAssigned && role !== "service_desk") msg = { text: "Paste the provider's or technician's update as soon as you receive it.", tone: "normal" };
  else if (i.phase === "awaiting_rfo" && i.rfoStatus === "awaiting" && role !== "service_desk") msg = { text: "Link restored. Enter the verified RFO when the provider supplies it.", tone: "normal" };
  else if (i.phase === "restoring") msg = { text: "Link is back up. The portal is confirming it stays up before telling customers.", tone: "normal" };
  return (
    <div className={clsx("rounded-xl border px-3.5 py-3 text-[13.5px] font-semibold",
      msg.tone === "urgent" ? "pulse-red border-primary bg-primary text-white" : msg.tone === "normal" ? "border-warning-edge bg-warning-tint text-ink" : "border-success-edge bg-success-tint text-ink")}>
      <div className="mb-0.5 text-2xs font-bold uppercase tracking-wider opacity-80">Next action</div>
      {msg.text}
    </div>
  );
}
