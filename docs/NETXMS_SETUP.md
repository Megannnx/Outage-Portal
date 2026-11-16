# Connecting NetXMS to the portal

The portal receives outage and restoration events **directly from NetXMS** over HTTPS. Telegram stays as it is for people; the portal does not depend on it. (Telegram bots cannot read messages posted by other bots in groups, so "listening to the Telegram bot" is not a reliable integration.)

## 1. Create the ingestion token

On the portal host:

```bash
openssl rand -hex 32     # put this in .env as INGEST_TOKEN_NETXMS
```

Optionally restrict ingestion to the NetXMS server's address with `INGEST_ALLOWED_IPS=<netxms-ip>`.

## 2. Server action (Configuration › Actions)

Create an action **"Notify outage portal"** of type **Execute command on management server**:

```bash
curl -fsS -m 10 --retry 3 --retry-delay 2 -X POST "https://outages.atec.co.za/api/ingest/netxms" -H "Authorization: Bearer <INGEST_TOKEN_NETXMS>" -H "Content-Type: application/json" -d '{"event":"%N","code":%c,"object_id":%I,"object_name":"%n","ip":"%a","severity":%s,"timestamp":%T,"interface":"%<interfaceName>"}'
```

Macros used (NetXMS event-processing macros): `%N` event name, `%c` event code, `%I` object ID (decimal), `%n` object name, `%a` IP address, `%s` severity, `%T` event time (epoch seconds), `%<interfaceName>` interface name for interface events.

Notes:
* Re-sending is safe: the portal de-duplicates on object + event + timestamp, so `--retry` cannot create duplicate incidents.
* The user running `netxmsd` must be able to run `curl`. On Windows NetXMS servers use `C:\Windows\System32\curl.exe` and escape quotes for `cmd`.
* If object names may contain double quotes, drop `"object_name"` — the portal matches on object ID.
* Alternative without shell: an NXSL script action using NetXMS's built-in web-service support (`GetServerNode().getWebService(...)`) posting the same JSON.

## 3. Event processing policy (Configuration › Event Processing Policy)

Add a rule (keep your existing Telegram rule unchanged, the portal rule is additional):

| Source | Events | Action |
|---|---|---|
| Containers/nodes for your sites (or all) | `SYS_NODE_DOWN`, `SYS_NODE_UNREACHABLE`, `SYS_NODE_UP` | Notify outage portal |
| Uplink interfaces you want treated as "link" (optional) | `SYS_IF_DOWN`, `SYS_IF_UP` | Notify outage portal |

Event names treated as down/up are configurable in **Admin › Policies** if you use custom events.

## 4. Heartbeat (recommended)

So the portal can tell "no outages" from "NetXMS stopped talking to us", create a scheduled task on the NetXMS server (every 5 minutes) that runs:

```bash
curl -fsS -m 10 -X POST "https://outages.atec.co.za/api/ingest/netxms" -H "Authorization: Bearer <INGEST_TOKEN_NETXMS>" -H "Content-Type: application/json" -d "{\"event\":\"PORTAL_HEARTBEAT\",\"object_id\":0,\"timestamp\":$(date +%s)}"
```

The portal raises a critical alert when nothing (event or heartbeat) has arrived for `monitoringSilenceAlertMinutes` (default 60).

## 5. Map NetXMS objects to sites (Admin › Sites & monitoring)

For each site, add a **monitoring identifier**:

* **NetXMS object ID** of the device whose loss means *the site is down* (the headend/uplink router, e.g. `DWV L3GR10`) — mark **critical**. Object IDs are stable even if devices are renamed.
* Optional non-critical identifiers (e.g. name prefix `DWV L2`) are recorded for history but never open an incident on their own.
* A site is "down" when **any** critical identifier is down and "up" only when **all** are up.

Events from objects not linked to a site raise an alert listing the unknown object in **Admin › System health**, so nothing is silently ignored.

## 6. Test

```bash
curl -s -X POST https://outages.atec.co.za/api/ingest/netxms -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d "{\"event\":\"SYS_NODE_DOWN\",\"object_id\":1001,\"object_name\":\"DWV L3GR10\",\"timestamp\":$(date +%s)}"
# → {"result":"processed","incidentId":"…"}  and the incident appears as "Validating" in the portal.
```

Do this with `DELIVERY_MODE=capture` first; then send the matching `SYS_NODE_UP` within 3 minutes to see a short interruption recorded without any messages.

## Telegram backup (optional)

1. Create a bot for the portal (BotFather) and add it as **administrator of a private channel**.
2. Add a NetXMS notification channel (Telegram driver) that posts outage messages into that channel, using names like `DWV L3GR10 is down`.
3. `setWebhook` to `https://…/api/ingest/telegram` with `secret_token` = `TELEGRAM_WEBHOOK_SECRET`; set `TELEGRAM_ALLOWED_CHAT_IDS`.
4. Add `name_exact` identifiers (source "Any") and adjust the parsing pattern in **Admin › Policies** if your message wording differs.

Events from both paths are de-duplicated by site state, so running both does not double-count.
