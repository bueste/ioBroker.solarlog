# Billing module — technical reference

This document describes how `iobroker.solarlog` computes, stores, and reports the
per-apartment solar/grid consumption split for the Trimmis property (8 apartments +
`Allgemein`). It covers the same ground as the polished walkthrough shared with the
property manager and financial auditor, but is the version that lives with the code and
is expected to be kept in sync with it.

If this document and the code ever disagree, the code is authoritative — file an issue
or fix the doc in the same PR that changes behavior.

> A multi-user web application (login, TOTP, tenant management, dynamic reporting,
> periodic e-mail subscriptions) is **live** at `abr.bronnenhuber.ch`, on top of the same
> MariaDB database this adapter writes to. See [ARCHITECTURE.md](ARCHITECTURE.md) for how
> it's built and how the two systems share the database without a sync protocol.

## Data flow

```mermaid
flowchart LR
    SL[Solar-Log device] -->|every 30s| LIVE[ioBroker live states]
    LIVE --> NIGHT[Nightly job, 23:58]
    NIGHT -->|1x/day per meter| DB[(MariaDB\nmeter_daily / building_daily)]
    DB --> RPT[Report builder, XLSX]
    RPT --> DL[Manual download]
    RPT --> MAIL[Scheduled e-mail]
    RPT --> ARCH[(File storage, 1y retention)]
    LIVE -.status.feedinday.-> GRAF[Grafana]
```

| System | Purpose | Frequency |
|---|---|---|
| InfluxDB / Grafana | Live + historical monitoring, not part of billing | every poll (30s) |
| ioBroker states | Current-day/month figures for the admin UI | live |
| MariaDB | Durable, immutable billing journal — the only source of truth for reports | 1x/day, 23:58 |
| File storage / e-mail | Sent-report archive, 1 year retention | on schedule |

## Self-consumption allocation (ZEV proportional method)

The Solar-Log device measures building-wide production and consumption, but cannot
attribute which kWh in a given apartment came from PV vs. grid — that's not physically
measurable once PV and grid supply feed the same house wiring. The standard Swiss ZEV
approach allocates proportionally: every apartment gets the *same* self-consumption
percentage the whole building had that day, applied to its own consumption.

```
ratio = min(production_wh, consumption_wh) / consumption_wh      // lib/billing.js selfConsumptionRatio()

solarbezug[meter] = verbrauch[meter] * ratio
netzbezug[meter]  = verbrauch[meter] - solarbezug[meter]
```

`min()` caps `ratio` at 1.0 on days production exceeds consumption. Because
`netzbezug` is defined as the *remainder* of `verbrauch`, the two always sum to exactly
that meter's measured consumption, for any value of `ratio` — a kWh can never land in
both categories or neither.

Grid feed-in is the complementary quantity on the same cap:

```
einspeisung = max(0, production_wh - consumption_wh)
```

Once `ratio` saturates at 1.0, the remaining production is exactly what was fed back
into the grid. Since no apartment can ever be allocated more solar credit than its own
consumption, feed-in and per-apartment solar allocation can never double-count the same
kWh.

### Worked example

Tariffs: 0.20 CHF/kWh solar, 0.28 CHF/kWh grid.

**Day A** — production 60 kWh, consumption 100 kWh → `ratio = 0.6`

| meter | verbrauch | solarbezug | netzbezug | total_chf |
|---|--:|--:|--:|--:|
| WHG 1 | 10.0 | 6.0 | 4.0 | 2.32 |

`6.0 × 0.20 + 4.0 × 0.28 = 1.20 + 1.12 = 2.32`

**Day B** — production 150 kWh, consumption 100 kWh → `ratio = 1.0` (capped),
`einspeisung = 50 kWh`

| meter | verbrauch | solarbezug | netzbezug |
|---|--:|--:|--:|
| WHG 1 | 10.0 | 10.0 | 0.0 |

The 50 kWh feed-in shows up in `building_daily.einspeisung_kwh`, not in any apartment
row.

## Which meters are billed

```js
// lib/billing.js
function isBillableMeter(name) {
    return /^WHG \d+$/.test(name) || name === 'Allgemein';
}
```

| meter | meaning | billed? |
|---|---|---|
| `WHG 1`–`8` | individual apartments | yes |
| `Allgemein` | common-area consumption | yes |
| `WR 1`, `WR 2`, `WR 9` | inverters — measure production, not consumption | no |
| `Gesamt` | building-wide total — would double-count every apartment | no |

Applied twice: once where rows are written to MariaDB (`main.js
accumulateMonthlyPerDevice()`), and defensively again in the report builder
(`lib/report.js aggregateMeterRowsByMonth()`) — a non-apartment meter can never reach a
tenant's bill even if it somehow ended up in the database.

## MariaDB schema

Both billing tables are written with `INSERT ... ON DUPLICATE KEY UPDATE`, keyed on
`(reading_date, meter_name)` / `reading_date` — a second write for the same day
overwrites the row rather than duplicating it.

```sql
CREATE TABLE meter_daily (
  reading_date DATE NOT NULL,
  meter_name VARCHAR(64) NOT NULL,
  zaehlerstand_start_kwh DECIMAL(12,3),
  zaehlerstand_ende_kwh DECIMAL(12,3),
  verbrauch_kwh DECIMAL(12,3),
  solarbezug_kwh DECIMAL(12,3),
  netzbezug_kwh DECIMAL(12,3),
  tarif_netz DECIMAL(8,4),
  tarif_solar DECIMAL(8,4),
  total_chf DECIMAL(10,2),
  berechnungsmethode VARCHAR(20) NOT NULL DEFAULT 'tagesnetto',  -- 'tagesnetto' | 'integriert', see below
  PRIMARY KEY (reading_date, meter_name)
);

CREATE TABLE building_daily (
  reading_date DATE NOT NULL PRIMARY KEY,
  produktion_kwh DECIMAL(12,3),
  verbrauch_kwh DECIMAL(12,3),
  einspeisung_kwh DECIMAL(12,3),
  eigenverbrauchsquote DECIMAL(6,4),      -- actually stores AUTARKIEGRAD, see webapp Reports.php docblock
  berechnungsmethode VARCHAR(20) NOT NULL DEFAULT 'tagesnetto'
);

CREATE TABLE meter_yearly_historic (
  reading_year INT NOT NULL,
  meter_name VARCHAR(64) NOT NULL,
  yield_kwh DECIMAL(14,3),
  PRIMARY KEY (reading_year, meter_name)
);

-- Itemized flat monthly costs on top of the energy-based total (e.g. "Zaehlerkosten",
-- "Allgemeinstrom-Anteil") - a meter/month can carry several distinct named lines side
-- by side, hence bezeichnung being part of the primary key. Writable from BOTH sides
-- (adapter admin UI bulk-set, and the webapp's /tarife.php) - MariaDB is the single
-- source of truth, same as tariff_schedule below.
CREATE TABLE meter_umlagekosten (
  reading_year INT NOT NULL,
  reading_month INT NOT NULL,
  meter_name VARCHAR(64) NOT NULL,
  bezeichnung VARCHAR(100) NOT NULL DEFAULT 'Umlagekosten',
  umlagekosten_chf DECIMAL(10,2) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (reading_year, reading_month, meter_name, bezeichnung)
);

-- One row per calendar month; read by BOTH the adapter (getTariffsForMonth(), MariaDB
-- primary / ioBroker-state fallback) and the webapp (Tariffs.php) - see ARCHITECTURE.md
-- "Tarife/Umlagekosten sync" for the bug this schema's write/read symmetry fixes.
CREATE TABLE tariff_schedule (
  reading_year INT NOT NULL,
  reading_month INT NOT NULL,
  netzbezug_chf_kwh DECIMAL(8,4) NOT NULL,
  solarbezug_chf_kwh DECIMAL(8,4) NOT NULL,
  PRIMARY KEY (reading_year, reading_month)
);
```

`meter_yearly_historic` holds coarse 2020–present yearly sums imported from the
adapter's pre-existing yearly archive states. Context only — it has no solar/grid split
and no day-level granularity, so it's excluded from billing reports entirely.

### Hybrid self-consumption method: `tagesnetto` vs. `integriert` (since 2.5.14)

The proportional-allocation `ratio` above (2.5.13 and earlier: **always** the coarse
"Tagesnetto" method — same-day net production vs. net consumption) has a known blind
spot: on a day with both a morning grid draw AND an evening feed-in (e.g. cloudy morning,
sunny evening), netting the whole day together can misstate how much of that day's
consumption was actually solar-covered in real time. Since 2.5.14 the adapter also builds
a true **intraday-integrated** ratio (`accumulateIntradayDelta()`, `main.js`) — it diffs
`status.yieldday`/`status.consyieldday` on every ~30s poll and accumulates genuine
self-consumed/grid-drawn/fed-in energy for elapsed intervals only, never bridging a poll
gap longer than 5 minutes with an assumption of constant power.

At the nightly write (`accumulateMonthlyPerDevice()`), the adapter picks whichever method
it can trust for that specific day:

```js
const INTRADAY_COVERAGE_THRESHOLD = 0.95; // main.js
if (coverageRatio >= INTRADAY_COVERAGE_THRESHOLD && selfConsumedWh + gridDrawWh > 0) {
    ratio = selfConsumedWh / (selfConsumedWh + gridDrawWh);   // true intraday integration
    berechnungsmethode = 'integriert';
} else {
    ratio = selfConsumptionRatio(yieldWh, consWh);            // same-day-net fallback
    berechnungsmethode = 'tagesnetto';
}
```

`coverageRatio` = seconds of the day actually covered by uninterrupted polling ÷ seconds
elapsed since midnight. Below 95% (VPN outage, ioBroker/adapter restart mid-day, Solar-Log
unreachable, etc.) the day automatically falls back to the coarser but always-available
Tagesnetto method rather than trusting a partial integration. Both methods are persisted
per row (`meter_daily.berechnungsmethode` / `building_daily.berechnungsmethode`), never
silently mixed into one number — the webapp surfaces this transparently (dashboard hint
text, per-month badges on the Wohnungen detail page) so a Verwaltung/Vermieter always
knows how many days of a given period used which method.

## Reconciliation guarantees

These are enforced by unit tests (`db.test.js`, `report.test.js`), not just a comment —
each has a regression test proving it, added when the corresponding bug was found and
fixed (2.5.7).

1. **Daily row**: `total_chf` is computed from the *rounded* `solarbezug_kwh` /
   `netzbezug_kwh` values — the same figures stored in that row — not from unrounded
   intermediate values. Recomputing `Solarbezug × Tarif + Netzbezug × Tarif` from what's
   in the row always reproduces `total_chf` exactly.
2. **Monthly report row**: since the tariff is constant across a calendar month
   (`Tarif.<year>.<month>.*`), `Total Bezug CHF` in `lib/report.js
   aggregateMeterRowsByMonth()` is recomputed from the rounded *monthly* kWh sums, not
   from summing ~30 independently-rounded daily `total_chf` values (which can drift a
   few Rappen from the monthly figure due to compounding rounding).
3. **Zählerstand idempotency**: `Database.lastAccumulatedDate` records the last date
   `accumulateMonthlyPerDevice()` successfully processed. A second invocation for an
   already-processed date is skipped with a warning — without this, a double-fire (e.g.
   a restart landing on the nightly cron) would silently add that day's consumption
   twice into the running lifetime meter reading, unlike the MariaDB row (which is
   upsert-safe by construction).

4. **Report format parity (adapter ↔ webapp)**: both the adapter's scheduled/manual XLSX
   (`lib/report.js buildReportWorkbook()`) and the webapp's on-demand "Nachversand"/
   subscription XLSX (`private/src/ReportMail.php buildXlsx()`) render the exact same two
   sheets, columns, and monthly-aggregation logic — verified this way rather than assumed,
   by generating both for the same period and diffing every cell programmatically
   (Python/openpyxl). Fixed as a genuine divergence found during that check (2.5.16-era):
   the "Gebaeude" sheet's date column was silently rendered one day early in every report
   ever generated by the adapter, because ExcelJS serializes a raw JS `Date` object via
   its *UTC* fields while the `mariadb` driver hands back `reading_date` at *local*
   midnight — in Europe/Zurich summer time (UTC+2) that's 22:00 UTC the previous day. Now
   written as a plain `"YYYY-MM-DD"` string instead of a native date cell
   (`formatDateForSheet()`), with a regression test for both the `Date`-object and
   string-input cases.

### Known methodological limit

The building-wide `ratio` is computed from the Solar-Log device's own aggregate
telemetry (`status.yieldday` / `status.consyieldday`), not from summing the individual
submeters. If the two diverge slightly (measurement tolerance, unmetered losses), each
meter's own split is still exact (guarantee #1 above), but the sum of solar kWh across
all apartments can differ marginally from the device's own reported total
self-consumption. This is inherent to the proportional ZEV method, not a bug.

## Reports

`lib/report.js buildReportWorkbook()` produces two sheets:

- **Abrechnung** — one row per apartment per calendar month:
  `Jahr | Monat | Wohnung | Solarstrombezug kWh | Tarif Solarstrom CHF/kWh | Netzbezug
  kWh | Tarif Netzbezug CHF/kWh | Total Bezug CHF`. Month is spelled out in German.
- **Gebaeude** — the daily building-wide series (production/consumption/feed-in/ratio),
  for context.

Three ways to get one:

1. **Current period**, regenerated nightly after the MariaDB write, and on demand via
   the "Generate current-period report now" button on the Billing admin tab (message
   command `generateReport`) — returns a direct `/files/...` download link.
2. **Scheduled**: monthly/quarterly/yearly, cutoff day 1–31 (31 = last day of month,
   clamped correctly including February — see `lib/scheduling.js`). Saved to
   `export/sent/<year>/` *before* the e-mail send attempt, so a working copy survives a
   failed send; retained 1 year, then auto-cleaned (`cleanupSentReports()`).
3. **Direct SQL** against `meter_daily`/`building_daily` for ad-hoc analysis — the
   database is the source of truth; reports are a derived view.

## Security posture

| Area | Measure |
|---|---|
| DB transport | Full TLS certificate chain + hostname verification (`ssl: { rejectUnauthorized: true }`, since 2.5.13), OR a local SSH tunnel with TLS off (`mariadbUseSsl: false`, since 2.5.18) — see "MariaDB via SSH tunnel" below. The direct-TLS path needs the `*.cyon.net` hostname in `mariadbHost`, not the IP, or hostname verification fails (it was briefly misdiagnosed as self-signed for exactly that reason). |
| Credentials | `mariadbPassword` is `encryptedNative` + `protectedNative`; never logged. |
| SQL | 100% parameterized queries (`lib/db.js`), no string interpolation of any input. |
| Admin UI | No `.html()`/`innerHTML` usage — all dynamic output goes through `.text()`. |
| Input validation | DB host (IPv4 w/ real octet ranges, or FQDN with a dot), recipient e-mail (typed field + regex), e-mail instance (existence + alive check before every send). |
| Dependencies | `npm audit fix` (non-breaking) applied for axios/form-data/brace-expansion. A larger set of transitive vulnerabilities (uuid/exceljs/googleapis, the latter used by an unrelated adapter on this shared host) needs `--force` and was deliberately left for a separate, explicitly-approved maintenance pass. |

## MariaDB via SSH tunnel (since 2.5.18)

The direct TLS connection to Cyon (`mariadbHost: s076.cyon.net`) had become
increasingly unreliable starting around 2026-09-05 and escalating sharply on
2026-09-09/10 (897 and 1093 failed connection attempts those two days, vs.
~580/day the week before) — bad enough that the nightly accumulation
(23:58) silently missed **two consecutive days entirely** (2026-09-10 and
2026-09-11 have no `meter_daily`/`building_daily` rows at all; see "Known
data gaps" below).

**Root cause**: a broken/degraded IPv6 route from the adapter host
(`10.195.30.116`) to `s076.cyon.net`. DNS for that hostname resolves to both
an IPv6 and an IPv4 address; the `mariadb` Node driver (like most TCP
clients) tries the addresses in the order returned and doesn't fall back to
IPv4 quickly, so a bad IPv6 path causes the whole connection attempt to hang
or fail instead of just skipping to the working IPv4 address. Confirmed by
reproducing the exact same behavior with plain `ssh` to the same host
(`ssh swisslin@s076.cyon.net` hung; `ssh -4 swisslin@s076.cyon.net`
connected instantly).

**Fix**: route the MariaDB connection through an SSH tunnel instead of
connecting directly, forcing IPv4 for the tunnel's own connection (sidesteps
the broken IPv6 path entirely, independent of whatever eventually gets that
route fixed on Cyon's or the ISP's end).

```
ioBroker host (10.195.30.116)                    Cyon (s076.cyon.net)
┌─────────────────────────────┐                  ┌───────────────────────┐
│ solarlog.0 adapter            │                  │                         │
│  mariadbHost=127.0.0.1        │                  │  MariaDB               │
│  mariadbPort=33066            │                  │  127.0.0.1:3306        │
│  mariadbUseSsl=false          │                  │  (localhost-only)      │
│         │                      │                  │        ▲                │
│         ▼                      │   SSH, IPv4      │        │                │
│  127.0.0.1:33066 ◀────────────┼──── forced (-4) ──┼────────┘                │
│  systemd: mariadb-tunnel-cyon  │   encrypted        (swisslin, restricted    │
│           .service             │   end-to-end        key: forwarding-only)  │
└─────────────────────────────┘                  └───────────────────────┘
```

**systemd unit** (`/etc/systemd/system/mariadb-tunnel-cyon.service` on the
adapter host, not part of this repo — infrastructure, not adapter code):

```ini
[Service]
Type=simple
User=root
ExecStart=/usr/bin/ssh -4 -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new \
  -L 127.0.0.1:33066:127.0.0.1:3306 swisslin@s076.cyon.net
Restart=always
RestartSec=5
```

`-4` is not optional — dropping it reproduces the original hang. `Restart=always`
gives resilience without needing `autossh` (not installed, and unnecessary here).

**SSH key**: a dedicated ed25519 key for `root@10.195.30.116`, added to
`swisslin@s076.cyon.net`'s `authorized_keys` with:

```
command="echo Port-forwarding-only; exit",no-agent-forwarding,no-X11-forwarding,no-pty,permitopen="127.0.0.1:3306"
```

This key can **only** forward to `127.0.0.1:3306` on Cyon — no shell, no
other port, no access to the other sites hosted under the same `swisslin`
account. (Pitfall hit while setting this up: OpenSSH's shorthand keyword is
`restrict`, not `restricted` — a typo'd option name isn't rejected with an
error, it just silently makes the whole key line unparseable, causing a
generic "Permission denied" with no clue why. And `restrict` alone disables
port-forwarding entirely; `permitopen=` only NARROWS an already-enabled
forward, it doesn't grant one — so `restrict` and `permitopen` together
without also re-enabling forwarding is a second way to end up silently
blocked. Used neither: the explicit `no-agent-forwarding,no-X11-forwarding,
no-pty` list plus `permitopen` achieves the same restriction without either
trap.)

**Why `mariadbUseSsl: false` for the tunnel, not just "SSL without hostname
verification"**: two things rule out a middle ground. A loopback address can
never match the server's real `*.cyon.net` certificate, so hostname
verification is a non-starter regardless. And Cyon's MariaDB was found to
**require** a real TLS handshake even for a plain TCP connection to
`127.0.0.1:3306` — a non-TLS connection attempt is accepted at the TCP level
but then closed without ever sending the initial handshake packet
(`ERROR 2013: Lost connection ... at 'handshake: reading initial
communication packet'`). Since the SSH tunnel already encrypts the traffic
end-to-end, the correct setting is TLS off entirely for the tunnel, full
TLS+verification for anything else — never a half-measure of one without the
other.

### Known data gaps

`meter_daily`/`building_daily` have **no rows for 2026-09-10, 2026-09-11,
2026-09-13, 2026-09-14, 2026-09-15, 2026-09-16, and 2026-09-17** — the first
two from the dead MariaDB connection (see above), the remaining five from a
second, unrelated incident (see next section) where the installed adapter
was silently replaced with the unmodified upstream package for almost a
week. Not backfilled as of 2026-09-18; whether/how to reconstruct these days
from the Solar-Log device's own 31-day rolling raw history (see the 2026-08
backfill precedent — same mechanism, same caveats about not summing
individual inverter registers) is a decision for whoever's handling billing
for that period, not something to do silently. Note the 31-day window means
2026-09-10/11 are close to aging out of the device's own history if a
backfill is wanted.

## Deployment identity: why this MUST be a non-npm (git) install

**Incident, 2026-09-13 to 2026-09-18**: this fork and the public
`iobroker-community-adapters/ioBroker.solarlog` package share the exact same
npm package name (`iobroker.solarlog`) — nothing at the filesystem or
ioBroker-object level distinguished "this specific fork with billing
features" from "the generic upstream monitor". Someone (most likely another
person with Admin access to this shared ioBroker instance — the host VM
belongs to a co-owner of the property, not solely to whoever maintains the
billing side) used ioBroker Admin's adapter list to "update" or "reinstall"
solarlog, which silently `npm install`ed the real published package (v2.4.0,
by the original author) over this fork's files. The replacement adapter has
none of the billing code (no `lib/`, no MariaDB, no `Tarif.*`/`Database.*`
states) but keeps the same instance ID, so nothing *looked* broken — Solar-Log
polling, live states, Grafana/InfluxDB all kept working normally. Only the
billing pipeline silently stopped, discovered five days later purely because
`meter_daily` had no new rows.

**Fix**: install as a genuine git-based ("non-npm") adapter instead of a
manually-copied or plain-npm-name install, so js-controller's own host log
and object metadata always show the true source:

```
instance system.adapter.solarlog.0 in version "2.5.19"
  (non-npm: git@github.com:bueste/ioBroker.solarlog.git#feature/installer-login-and-monthly-consumption)
```

```bash
iobroker url 'git@github.com:bueste/ioBroker.solarlog.git#feature/installer-login-and-monthly-consumption' solarlog
```

Requires a repo-scoped SSH deploy key (write-enabled) for
`github.com/bueste/ioBroker.solarlog`, configured for `root` on the adapter
host via `~/.ssh/config` (`IdentityFile`/`IdentitiesOnly yes` pinned to that
one key, so it's never used for anything beyond this one repo). A previous
attempt using a local filesystem path (`iobroker url /opt/dev/iobroker.solarlog
solarlog`) failed with `CANNOT_FIND_ADAPTER_DIR` — npm installs a local path
as a symlink rather than a copy, and js-controller doesn't resolve that
correctly; a real git URL avoids the symlink entirely and is also more
correct (the running code is a byte-for-byte pinned checkout, not a live
pointer into a `root`-owned dev directory two other people can also write to).

**A real bug this surfaced**: `package.json`'s `"files"` allowlist never
included `lib/` (an oversight from when the module was split out of
`main.js`) — irrelevant for a manual file-copy deploy (which ignores that
field entirely), but a genuine `npm`/git install respects it strictly, so
the *first* git-install attempt silently produced an adapter with `main.js`
but no `lib/db.js`/`lib/report.js`/etc. at all. Fixed in 2.5.19 alongside
correcting `repository.url` (was still pointing at the upstream project).

**This is now the only supported deploy path going forward** — a manual
`cp` from `/opt/dev/iobroker.solarlog` still works for quick local testing,
but the AUTHORITATIVE live install must be re-applied via the `iobroker url`
command above after every change that should reach production, or the
non-npm provenance metadata (and the protection it provides) is lost again.
`common.automaticUpgrade` is additionally set to `"none"` on the instance as
a second, independent layer of defense.

## Admin configuration reference

All fields live on the **Billing** tab of the instance settings.

| Field | Purpose |
|---|---|
| MariaDB host/port/user/password/database | DB connection; "Test connection" verifies live |
| `mariadbUseSsl` (since 2.5.18) | Uncheck only when `mariadbHost` is a local SSH-tunnel endpoint (`127.0.0.1`) — see "MariaDB via SSH tunnel" above |
| `Tarif.default.*`, `Tarif.<year>.<month>.*` | Editable in the object tree; per-month overrides the default |
| Report recipient / e-mail instance | Validated e-mail field + instance existence check |
| Report schedule / cutoff day | monthly/quarterly/yearly, day 1–31 |
| "Generate current-period report now" | Immediate XLSX + download link |
| "Send test e-mail" | Exercises the full send path against the current config |
