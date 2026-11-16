# Administrator guide

## Your job in one paragraph

You approve the exact wording customers receive, keep sites/ISPs/contacts accurate, and set the policies (validation time, update interval, escalations). The portal does the rest. Nothing is ever sent with wording that has not been approved by an administrator other than its author.

## First day

1. Sign in with the bootstrap account, enrol two-factor (any TOTP app).
2. **Admin › Users** — create a second administrator (needed to approve wording), Service Desk and Technical users. Passwords ≥ 12 characters.
3. **Admin › Communication templates** — the portal ships with starter wording for every scenario, **pending approval**. Read each one, edit if needed (that creates a new version), and have the *other* administrator approve it. Until a template is published it will never be used.
4. **Admin › Sites & monitoring** — add every site (code, name, estate, backhaul provider, circuit, upstream POP, resident distribution reference) and its NetXMS **object ID** as a *critical* identifier. Link ISPs to each site.
5. **Admin › ISPs & contacts** — add ISPs and their outage contacts; add the NOC team mailbox as an *internal* contact for team `NOC`.
6. **Admin › Policies & escalations** — check validation (3 min), interval (120 min), stability period (5 min), escalation thresholds and who is notified, cause options and fault vocabulary wording.
7. Connect NetXMS (`docs/NETXMS_SETUP.md`) and test in capture mode.

## Go-live checklist

- [ ] Every template you need is **published** (green "v1" or later).
- [ ] Every site has a critical identifier, a resident distribution reference and at least one ISP.
- [ ] *Delivery & data-quality problems* panel is empty.
- [ ] NetXMS heartbeat arriving (Admin › System health › Integrations).
- [ ] SMTP + client API configured; send a test by simulating an outage on a test site.
- [ ] Two admins have MFA.
- [ ] Switch `DELIVERY_MODE=live` and restart `web` and `worker`. The red banner disappears.

## Writing templates

**Backhaul providers are private.** There is no provider placeholder, and the portal refuses any template, cause/fault wording or RFO that names a backhaul provider (name, display name or alias) or Connexifi. Provider details stay internal: sites, Technical panel, internal alerts and reports.

Placeholders insert **verified** facts: `{{site_name}} {{estate_name}} {{incident_reference}} {{outage_start_time}} {{confirmed_cause}} {{fault_description}} {{repair_status}} {{eta}} {{next_update_time}} {{rfo}} {{support_contact}} {{restored_time}} {{downtime}} {{affected_sites}}`.

* `{{eta}}` on its own means "this message **requires** a verified ETA". If none exists, the engine automatically uses the next template in the chain (e.g. *ETA unavailable*). That is how the portal guarantees it never invents an ETA.
* `{{#eta}}The estimated restoration time is {{eta}}.{{/eta}}` — shown only when an ETA is verified.
* `{{^eta}}No restoration time has been confirmed yet.{{/eta}}` — shown only when there isn't one.
* The editor shows two live previews: with all facts known, and with optional facts unknown.
* Required placeholders per kind are enforced (e.g. *ETA available* must contain `{{eta}}`; *Final RFO* must contain `{{rfo}}`).
* Create an **ISP-only** version of any kind (Add audience-specific template) when ISPs need more technical wording. Residents keep the shared version.
* Version history keeps every wording ever published, who approved it and when. *Roll back* re-submits an old version for approval.

Wording also comes from three admin vocabularies flagged *customer-facing*: cause option "customer wording", fault "customer wording", provider "name used in messages". Treat changes there like template changes.

## Exceptional workflows

* **Close without RFO** (incident page, administrators only): requires a written reason; recorded in the audit log; optionally sends the approved *resolved (no RFO)* message.
* **Sites that never need an RFO**: untick *RFO required* on the site; restoration sends the final message directly.
* **Related outages**: when several sites on the same upstream POP or circuit fail together the portal suggests linking them. Technical accepts with one click; a single technical update then applies to all of them and each ISP gets one combined message.

## Reports

**Reports** — choose a month (and optional filters), read the findings, export **PDF** (management pack), **Excel** (all tables) or **CSV**. Every number is computed from recorded events; definitions are at the bottom of the page and in the PDF. With little data the report says so instead of drawing conclusions.
