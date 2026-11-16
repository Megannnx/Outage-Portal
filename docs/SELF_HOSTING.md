# Self-hosting on a Linux VM

## 1. VM specification

| | Minimum | Recommended |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB (the build peaks at ~2 GB; the installer adds swap if RAM is low) |
| Disk | 40 GB SSD | 60 GB SSD |
| OS | Ubuntu 22.04 / 24.04 LTS or Debian 12, 64-bit | Ubuntu 24.04 LTS |
| IP | Static | Static |

Everything runs on this one VM in Docker: PostgreSQL 17, migrations, the web app, two background workers (timers, deliveries, escalations), nightly backups, and Caddy for automatic HTTPS.

Typical load is tiny: a few hundred incidents a month and tens of jobs a minute at peak. The recommended size is about headroom for builds and backups, not traffic.

### Network

| Direction | Port | Purpose |
|---|---|---|
| Inbound | 443 (and 80 for certificate issuing) | Staff, technicians' phones (dispatch links), NetXMS events |
| Inbound | 22 | Your SSH administration |
| Outbound | 443 | GitHub + npm (install/update), client-base API, Let's Encrypt, optional AI |
| Outbound | 587 (or your relay's port) | SMTP to ISPs and internal notifications |
| Outbound | 993 | Bounce mailbox (optional) |

Two ways to expose the portal:
- **Public mode** (recommended): a DNS name such as `outages.atec.co.za` pointing at the VM, with ports 80/443 reachable. HTTPS is automatic.
- **Internal mode**: `http://<vm-ip>:3000` on your LAN or VPN only. Technicians can't open dispatch links off-site, and traffic is plain HTTP, so use it only on a trusted network or behind your own HTTPS proxy.

## 2. Install

On the new VM:

```bash
# Option A — clone with a read-only GitHub token (the installer asks for it, uses it once, does not store it)
curl -fsSLO https://raw.githubusercontent.com/Megannnx/outage-portal/main/install.sh   # needs a token for private repos;
# or copy install.sh / the whole project folder to the VM with scp, then:
sudo bash install.sh
```

The installer:
1. Checks the VM.
2. Installs Docker and the prerequisites.
3. Places the code in `/opt/atec-outage-portal`.
4. Generates `.env` with new secrets. They are never shown; the file is `chmod 600`.
5. Configures the firewall.
6. Builds and starts every service.
7. Installs a 5-minute watchdog and the `atec-portal` command.
8. Waits until the portal reports healthy.

It is safe to re-run: your `.env`, database and backups are kept.

Then open `https://<your-domain>/setup` and create the first administrator.

## 3. Day to day

```bash
atec-portal status          # containers, health, job queue, alerts, disk, latest backup
atec-portal logs            # follow web + worker logs
atec-portal update          # backup → pull latest code → rebuild → restart
atec-portal backup          # manual backup to /opt/atec-outage-portal/backups
atec-portal restore <file>  # restore a backup
atec-portal restart
```

Configuration lives in `/opt/atec-outage-portal/.env` (SMTP, client API, delivery mode). After editing it, run `atec-portal restart`.

## 4. Monitoring

| What | How |
|---|---|
| Portal health | `GET https://<domain>/api/health` returns **200** when the database and workers are fine, **503** when not. Add it to **NetXMS** as an HTTP check (or to any uptime monitor) and alert on non-200. |
| Self-healing | Cron runs `atec-portal watchdog` every 5 min. It restarts services if unhealthy, or the worker if its heartbeat is stale, and logs to syslog: `journalctl -t atec-portal`. |
| Container restarts | Every service has `restart: unless-stopped`. The web container also has a Docker health check. |
| In-app | The header shows the worker/live status; the bell lists alerts; **Admin › System health** shows integrations, the queue, dead jobs and the audit-log integrity check. |
| VM | Monitor CPU, RAM, disk (alert above 80 %) and the age of the newest file in `/opt/atec-outage-portal/backups` with your usual NetXMS agent. |

## 5. Backups

A nightly `pg_dump` goes to `/opt/atec-outage-portal/backups` and is kept for 30 days (`BACKUP_KEEP_DAYS`).

**Copy these off the VM**, for example with a nightly `rsync`/`rclone` to another server or to cloud storage. Also keep a copy of `/opt/atec-outage-portal/.env` in your password vault: without `APP_ENCRYPTION_KEY`, users must re-enrol two-factor.

## 6. Moving from the hosted (Vercel + Supabase) version

1. Install on the VM as above, but **don't** complete `/setup`.
2. In Supabase (ATEC Outage Portal project), go to **Connect → Direct → Session pooler**. Copy the URI, put the database password in it, and run on the VM:
   ```bash
   atec-portal import-supabase 'postgresql://postgres.xxxx:PASSWORD@aws-…pooler.supabase.com:5432/postgres'
   ```
   This copies everything: users, sites, templates and approvals, incidents and history. Users then re-enrol two-factor, because the VM has its own encryption key.
3. Turn off the hosted copy so two systems never send messages:
   - In Supabase SQL editor: `select cron.unschedule('portal-tick');`
   - In Vercel: delete or pause the `atec-outage-portal` project.
4. Point NetXMS at the VM's address with the token shown in **Admin › System health › Integration tokens** on the VM.
