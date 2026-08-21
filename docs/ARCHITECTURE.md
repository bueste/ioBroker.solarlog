# Architekturkonzept: Abrechnungs-Webapplikation

> Status: **Konzept**. Keine der hier beschriebenen Webapp-Komponenten existiert bisher -
> dieses Dokument beschreibt die Zielarchitektur für eine künftige, separate PHP-Webapplikation
> unter `abr.bronnenhuber.ch`, die auf derselben MariaDB aufsetzt, die `iobroker.solarlog`
> heute schon für das Abrechnungsjournal nutzt. Siehe [BILLING.md](BILLING.md) für die bereits
> implementierte Abrechnungslogik im Adapter.

## Ausgangslage

Die Solarabrechnung für Trimmis läuft heute vollständig über den ioBroker-Adapter (lokal,
`10.195.30.116`) und eine gemeinsame MariaDB auf Cyon (`149.126.4.85`, Host `s076.cyon.net`).
Geplant ist eine richtige, mehrbenutzerfähige Abrechnungs-Webapplikation: Login für Verwaltung
und Eigentümer/Vermieter, optionales TOTP, Mieter-Stammdaten (Adresse) pro Wohnung, dynamische
Auswertungen - erreichbar unter `abr.bronnenhuber.ch`, gehostet auf normalem
Cyon-Webhosting.

**Wichtige Abgrenzung:** TOTP ist ausschliesslich eine Sache der Webapplikation - der
ioBroker-Adapter hat damit nichts zu tun, weder beim Speichern noch beim Prüfen.

## Systemarchitektur

```
┌───────────────────────────┐        ┌──────────────────────────────┐        ┌─────────────────────────────┐
│  ioBroker.solarlog          │        │   MariaDB (Cyon,               │        │   Webapplikation (PHP,        │
│  (lokal, 10.195.30.116)     │──TLS──▶│   s076.cyon.net)               │◀──TLS──│   Cyon Shared Hosting,        │
│  - Solar-Log Polling        │  write │   - meter_daily                 │  read/ │   abr.bronnenhuber.ch)        │
│  - Nächtl. Akkumulation     │        │   - building_daily              │  write │   - Login/Sessions/TOTP       │
│  - Tarif-Bulk-Set (Admin)   │        │   - tariff_schedule              │        │   - Mieterverwaltung          │
│  - lokaler Fallback ohne    │        │   - meter_umlagekosten           │        │   - Dynamische Auswertungen   │
│    MariaDB möglich          │        │   - meter_yearly_historic        │        │   - PDF/XLSX-Export            │
│                              │        │   - (NEU, von Webapp verwaltet) │        │                                 │
│                              │        │     users, tenants,              │        │                                 │
│                              │        │     sessions, audit_log          │        │                                 │
└───────────────────────────┘        └──────────────────────────────┘        └─────────────────────────────┘
```

**"Lokal oder synchron mit Webhosting":** bereits mit der bestehenden `mariadbEnabled`-Option im
Adapter gelöst, kein neues Sync-Protokoll nötig:

- `mariadbEnabled = false` → Adapter arbeitet rein lokal (nur ioBroker-Zustände).
- `mariadbEnabled = true` (heutiger Zustand) → Adapter schreibt zusätzlich in die gemeinsame
  MariaDB, die bereits auf Cyon-Infrastruktur liegt. **Die Datenbank selbst ist die
  Synchronisationsschicht** - die künftige Webapp liest/schreibt dieselbe DB direkt.

## Schema-Eigentümerschaft

- **Adapter besitzt** (`lib/db.js`, `ensureSchema()`): `meter_daily`, `building_daily`,
  `tariff_schedule`, `meter_umlagekosten`, `meter_yearly_historic`. Reine Abrechnungsdaten.
- **Webapp besitzt** (eigenes Repo, eigene Migrationen): `users`, `tenants`, `sessions`,
  `audit_log`. Anwendungsdaten (Login, Mieter-Stammdaten).
- Verknüpfung über den gemeinsamen `meter_name`-String (z.B. `"WHG 1"`), lose gekoppelt statt
  über einen Fremdschlüssel quer über zwei unabhängig migrierte Schemas.

### Vorgeschlagenes Schema für die Webapp

```sql
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,       -- PHP password_hash() (bcrypt)
  role ENUM('verwaltung','vermieter') NOT NULL,
  totp_secret VARCHAR(64) NULL,               -- nur Webapp, Klartext (siehe Sicherheitsmodell)
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL
);

CREATE TABLE tenants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meter_name VARCHAR(64) NOT NULL,            -- z.B. "WHG 1"
  vorname VARCHAR(100) NOT NULL,
  nachname VARCHAR(100) NOT NULL,
  strasse VARCHAR(150) NOT NULL,
  plz VARCHAR(10) NOT NULL,
  ort VARCHAR(100) NOT NULL,
  land VARCHAR(2) NOT NULL DEFAULT 'CH',
  email VARCHAR(255) NULL,
  telefon VARCHAR(30) NULL,
  mietbeginn DATE NULL,
  mietende DATE NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_meter_name (meter_name)
);

CREATE TABLE sessions (
  id CHAR(64) PRIMARY KEY,                    -- Hash des Session-Tokens, NIE das Token selbst
  user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INT NULL,                           -- NULL = durch den Adapter, nicht durch die Webapp
  action VARCHAR(64) NOT NULL,                -- z.B. "tariff.update", "tenant.create", "login.failed"
  target VARCHAR(128) NULL,
  details JSON NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

## Sicherheitsmodell (Webapp)

- **Passwörter:** `password_hash()`/`password_verify()` (PHP, bcrypt) - Standard, kein
  Custom-Crypto.
- **TOTP:** RFC 6238, via einer schlanken PHP-TOTP-Bibliothek (falls Composer verfügbar) oder
  einer minimalen Eigenimplementierung. Secret liegt **im Klartext in MariaDB** - gleiches
  Vertrauensmodell wie die übrigen Abrechnungsdaten bereits heute: TLS-Transport +
  DB-Zugriffsschutz, kein zusätzlicher geteilter Schlüssel zwischen Adapter und Webapp nötig.
- **Sessions:** serverseitig, in `sessions` als Hash gespeichert (nicht das Token selbst) -
  erlaubt serverseitigen Widerruf. Cookie: `HttpOnly`, `Secure`, `SameSite=Strict`.
- **Rollen:** `verwaltung` (voller Zugriff), `vermieter` (lesend) - Rechteprüfung ist
  Anwendungslogik in der Webapp, nicht im Schema.
- **Login-Schutz:** Rate-Limiting auf fehlgeschlagene Logins (pro Account und pro IP),
  CSRF-Token auf allen Formularen, Passwort-Policy.
- **Audit-Log:** jede sicherheits-/abrechnungsrelevante Änderung wird protokolliert.

## Technologie-Wahl

Cyon-Standardhosting = PHP + MySQL/MariaDB, kein dauerhafter Node-Prozess möglich.

- **Backend:** PHP 8.x, schlanker Ansatz ohne schweres Framework - eigener kleiner Router + PDO,
  oder ein Micro-Framework falls Composer auf dem Cyon-Paket verfügbar ist.
- **Frontend:** serverseitig gerendertes PHP + gezielt eingesetztes JS (z.B. Alpine.js oder
  htmx) - modern/dynamisch ohne Node-Build-Prozess auf Shared Hosting.
- **Export:** PDF (PHP-PDF-Bibliothek) und XLSX (PhpSpreadsheet o.ä.).
- **Dynamische Auswertungen:** frei wählbare Zeiträume, Wohnung-für-Wohnung-Drilldown,
  Jahresvergleich, Solarquote-Trend, Umlagekosten-Übersicht - alles direkt aus
  `meter_daily`/`building_daily`/`tariff_schedule`/`meter_umlagekosten` ableitbar.

## Applikationsdesign & Features

Orientiert an einem etablierten Vergleichsprodukt für den Schweizer Markt (ZEV-/vZEV-Abrechnung
für Vermieter/Hausverwaltungen) - dessen öffentliche Produktbeschreibung bestätigt, dass die
Kernbausteine hier (proportionale Solarbezug/Netzbezug-Aufteilung, Tarifverwaltung,
Mieter-/Zähler-Übersicht, dynamische Statistiken) der richtige Funktionsumfang für dieses
Marktsegment sind.

**Ausdrücklich nicht Teil von v1:** Rechnungen und Gutschriften (inkl. Schweizer QR-Rechnung).
v1 ist ein reines **Auswertungs- und Verwaltungsportal**, keine Abrechnungsdokument-Erstellung.

### Rolle Verwaltung (voller Zugriff)

- **Dashboard:** Gebäudeübersicht - Eigenverbrauchsquote, Produktion/Verbrauch/Einspeisung des
  Monats, Kosten-Summe über alle Wohnungen, Auffälligkeiten (z.B. ein Zähler ohne aktuelle
  Werte - vgl. das bestehende Pushover-Monitoring-Skript).
- **Wohnungen/Zähler-Verwaltung:** Mieter anlegen/bearbeiten (Adresse, Ein-/Auszugsdatum),
  Zuordnung zu `meter_name`, Mieterwechsel-Historie (alter Mieter wird inaktiv gesetzt, nicht
  gelöscht).
- **Tarifverwaltung:** dieselbe Bulk-Set-Logik wie im ioBroker-Adapter (Von/Bis-Monat,
  Netzbezug/Solarbezug, optional Umlagekosten je Wohnung), direkt in der Webapp bedienbar.
  Historie aller Tarifänderungen sichtbar (aus `tariff_schedule`).
- **Dynamische Auswertungen:** frei wählbarer Zeitraum, Wohnung-für-Wohnung-Vergleich,
  Jahresvergleich, Solarquote-Trend, XLSX/CSV-Export.
- **Benutzerverwaltung:** weitere Logins anlegen, TOTP-Status einsehen (nicht das Secret
  selbst), Audit-Log einsehen.
- **DB-Status:** Health-Check-Anzeige, Pendant zum bestehenden `Database.testConnection` im
  Adapter.

### Rolle Eigentümer/Vermieter (lesend)

- **Dashboard:** dieselbe Gebäudeübersicht, ohne Bearbeitungsmöglichkeiten - Fokus auf
  Rendite/Ertrag (wie viel Solarstrom wurde intern "verkauft" statt eingespeist, in CHF).
- **Wohnungsübersicht:** pro Wohnung Verbrauch/Kosten, Mieter-Kontaktdaten nicht bearbeitbar
  (Sichtbarkeit je nach Datenschutz-Anspruch zu klären, wenn die Webapp gebaut wird).
- **Berichte/Export:** dieselben Auswertungen, rein lesend.
- **Kein Zugriff auf:** Tarifänderung, Mieterverwaltung, Benutzerverwaltung, Systemstatus.

### Seitenstruktur (v1)

```
/login                          Anmeldung (+ TOTP-Schritt, falls aktiviert)
/dashboard                      Gebäudeübersicht (rollenabhängige Inhalte)
/wohnungen                      Liste aller Wohnungen/Zähler
/wohnungen/{id}                 Detail: Verbrauch, Solarbezug/Netzbezug, Mieterdaten
/tarife                         Tarifhistorie + Bulk-Set (nur Verwaltung)
/auswertungen                   Freie Zeitraum-Auswertung, Vergleiche, Export
/benutzer                       Benutzerverwaltung + Audit-Log (nur Verwaltung)
/einstellungen                  Eigenes Profil, Passwort ändern, TOTP aktivieren/deaktivieren
```

### Spätere Phase (v2)

- Rechnungen/Gutschriften inkl. Schweizer QR-Zahlteil.
- Mieter-Zugang (eigener Login pro Wohnung, nur eigene Daten sichtbar).
- 80 %-Solartarif-Prüfung (Art. 16b Abs. 2 EnV) als Warnhinweis bei der Tarifverwaltung.

## Was noch fehlt, bevor umgesetzt werden kann

1. **DNS:** `abr.bronnenhuber.ch` einrichten (A/CNAME - konkreter Zielwert erst bekannt,
   sobald das Cyon-Paket für diese Subdomain feststeht).
2. **Hosting-Zugriff:** FTP/SSH- oder Git-Deploy-Zugang zum Cyon-Paket, auf dem
   `abr.bronnenhuber.ch` liegen soll.
3. **PHP-Version/Composer-Verfügbarkeit** auf dem gewählten Cyon-Paket prüfen, sobald Zugriff
   besteht - bestimmt die genaue Bibliothekswahl (TOTP, PDF/XLSX).

## Aktueller Umfang

Dieses Dokument ist der Stand der **Konzeptphase**. Es gibt noch keinen Code für die
Webapplikation, keine der oben beschriebenen neuen MariaDB-Tabellen und kein separates Repo.
Die Umsetzung folgt, sobald Hosting-Zugriff und DNS stehen.
