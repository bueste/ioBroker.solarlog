# Billing module — technical reference

This document describes how `iobroker.solarlog` computes, stores, and reports the
per-apartment solar/grid consumption split for the Trimmis property (8 apartments +
`Allgemein`). It covers the same ground as the polished walkthrough shared with the
property manager and financial auditor, but is the version that lives with the code and
is expected to be kept in sync with it.

If this document and the code ever disagree, the code is authoritative — file an issue
or fix the doc in the same PR that changes behavior.

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
  PRIMARY KEY (reading_date, meter_name)
);

CREATE TABLE building_daily (
  reading_date DATE NOT NULL PRIMARY KEY,
  produktion_kwh DECIMAL(12,3),
  verbrauch_kwh DECIMAL(12,3),
  einspeisung_kwh DECIMAL(12,3),
  eigenverbrauchsquote DECIMAL(6,4)
);

CREATE TABLE meter_yearly_historic (
  reading_year INT NOT NULL,
  meter_name VARCHAR(64) NOT NULL,
  yield_kwh DECIMAL(14,3),
  PRIMARY KEY (reading_year, meter_name)
);
```

`meter_yearly_historic` holds coarse 2020–present yearly sums imported from the
adapter's pre-existing yearly archive states. Context only — it has no solar/grid split
and no day-level granularity, so it's excluded from billing reports entirely.

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
| DB transport | TLS since 2.5.7 (`ssl: { rejectUnauthorized: false }`) — the remote host presents a self-signed cert, so this stops passive eavesdropping but not an active MITM. Operational follow-up: firewall the DB to this host's IP, or pin the cert. |
| Credentials | `mariadbPassword` is `encryptedNative` + `protectedNative`; never logged. |
| SQL | 100% parameterized queries (`lib/db.js`), no string interpolation of any input. |
| Admin UI | No `.html()`/`innerHTML` usage — all dynamic output goes through `.text()`. |
| Input validation | DB host (IPv4 w/ real octet ranges, or FQDN with a dot), recipient e-mail (typed field + regex), e-mail instance (existence + alive check before every send). |
| Dependencies | `npm audit fix` (non-breaking) applied for axios/form-data/brace-expansion. A larger set of transitive vulnerabilities (uuid/exceljs/googleapis, the latter used by an unrelated adapter on this shared host) needs `--force` and was deliberately left for a separate, explicitly-approved maintenance pass. |

## Admin configuration reference

All fields live on the **Billing** tab of the instance settings.

| Field | Purpose |
|---|---|
| MariaDB host/port/user/password/database | DB connection; "Test connection" verifies live |
| `Tarif.default.*`, `Tarif.<year>.<month>.*` | Editable in the object tree; per-month overrides the default |
| Report recipient / e-mail instance | Validated e-mail field + instance existence check |
| Report schedule / cutoff day | monthly/quarterly/yearly, day 1–31 |
| "Generate current-period report now" | Immediate XLSX + download link |
| "Send test e-mail" | Exercises the full send path against the current config |
