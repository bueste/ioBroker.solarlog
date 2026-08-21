# Architektur: Abrechnungs-Webapplikation (abr.bronnenhuber.ch)

> Status: **Implementiert und live** unter `https://abr.bronnenhuber.ch`, gehostet auf
> Cyon-Shared-Hosting (`s076.cyon.net`), eigenes Repo (`abr_billing_webapp`, nicht Teil
> dieses `iobroker.solarlog`-Repos). Dieses Dokument beschreibt den tatsächlich gebauten
> Zustand, nicht mehr nur ein Konzept — bei Abweichung zwischen diesem Dokument und dem
> Code ist der Code massgebend (gleiche Regel wie in [BILLING.md](BILLING.md)). Für die
> im Adapter implementierte Abrechnungslogik selbst siehe [BILLING.md](BILLING.md).

## Ausgangslage

Die Solarabrechnung für Trimmis läuft über zwei unabhängige Applikationen, die sich
ausschliesslich über eine gemeinsame MariaDB (`149.126.4.85`, Host `s076.cyon.net`)
synchronisieren:

- **`iobroker.solarlog`** (Node.js, lokal auf `10.195.30.116`) — pollt das Solar-Log-Gerät,
  akkumuliert nachts (23:58) die Tageswerte, schreibt `meter_daily`/`building_daily`, kann
  selbst Tarife setzen und Berichte per E-Mail versenden.
- **Abrechnungs-Webapp** (PHP 8.3, Cyon Shared Hosting) — Login für Verwaltung/Vermieter,
  Mieterverwaltung, dynamische Auswertungen, Tarifverwaltung, periodischer Berichtsversand.

**Wichtige Abgrenzung:** TOTP ist ausschliesslich eine Sache der Webapplikation - der
ioBroker-Adapter hat damit nichts zu tun, weder beim Speichern noch beim Prüfen.

## Systemarchitektur

```
┌───────────────────────────┐        ┌──────────────────────────────┐        ┌─────────────────────────────┐
│  ioBroker.solarlog          │        │   MariaDB (Cyon,               │        │   Webapp (PHP 8.3,             │
│  (lokal, 10.195.30.116)     │──TLS──▶│   s076.cyon.net)               │◀──TLS──│   abr.bronnenhuber.ch)        │
│  - Solar-Log Polling        │  write │   - meter_daily                 │  read/ │   - Login/Sessions/TOTP       │
│  - Nächtl. Akkumulation     │        │   - building_daily              │  write │   - Mieterverwaltung          │
│  - Tarif-Bulk-Set (Admin)   │        │   - tariff_schedule              │        │   - Tarif-/Umlagekostenpflege │
│  - lokaler Fallback ohne    │        │   - meter_umlagekosten           │        │   - Dynamische Auswertungen   │
│    MariaDB möglich          │        │   - meter_yearly_historic        │        │   - XLSX-Export & Abo-Mails    │
│                              │        │   - users, tenants, sessions,   │        │   - Cron: periodischer Versand │
│                              │        │     audit_log, report_          │        │                                 │
│                              │        │     subscriptions_custom        │        │                                 │
└───────────────────────────┘        └──────────────────────────────┘        └─────────────────────────────┘
```

**"Lokal oder synchron":** über die bestehende `mariadbEnabled`-Option im Adapter gelöst,
kein separates Sync-Protokoll:

- `mariadbEnabled = false` → Adapter arbeitet rein lokal (nur ioBroker-Zustände).
- `mariadbEnabled = true` (heutiger Zustand) → Adapter schreibt zusätzlich in die
  gemeinsame MariaDB. **Die Datenbank selbst ist die Synchronisationsschicht** — die
  Webapp liest/schreibt dieselbe DB direkt, kein API-Layer dazwischen.

## Schema-Eigentümerschaft

- **Adapter besitzt** (`lib/db.js`, `ensureSchema()`): `meter_daily`, `building_daily`,
  `tariff_schedule`, `meter_umlagekosten`, `meter_yearly_historic`. Reine
  Abrechnungsdaten — siehe [BILLING.md](BILLING.md) für die vollständigen `CREATE TABLE`-
  Statements.
- **Webapp besitzt** (eigenes Repo, `private/migrations/001`–`005`): `users`, `tenants`,
  `sessions`, `audit_log`, `report_subscriptions_custom`. Anwendungsdaten.
- Verknüpfung über den gemeinsamen `meter_name`-String (z.B. `"WHG 1"`), lose gekoppelt —
  bewusst kein Fremdschlüssel quer über zwei unabhängig migrierte Schemas.

### Webapp-Schema (tatsächlich implementiert)

Migrationen liegen unter `private/migrations/*.sql` im Webapp-Repo, werden **manuell**
angewendet (kein Migrationsrunner) — siehe README.md im Webapp-Repo für den genauen
Ablauf.

| # | Migration | Inhalt |
|---|---|---|
| 001 | `initial_schema.sql` | `users`, `tenants`, `sessions`, `audit_log` |
| 002 | `totp_required.sql` | `users.totp_required` — Admin kann TOTP pro Konto erzwingen |
| 003 | `password_reset.sql` | `users.reset_token_hash`/`reset_token_expires` |
| 004 | `user_names.sql` | `users.vorname`/`nachname` — für persönliche Anrede in Berichtsmails |
| 005 | `report_subscriptions.sql` | `users.report_sub_period` + zwei weitere Spalten (eigenes Abo); neue Tabelle `report_subscriptions_custom` (freie Empfänger, nur Vermieter) |

```sql
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  vorname VARCHAR(100) NULL,
  nachname VARCHAR(100) NULL,
  password_hash VARCHAR(255) NOT NULL,        -- PHP password_hash() (bcrypt)
  role ENUM('verwaltung','vermieter') NOT NULL,
  totp_secret VARCHAR(64) NULL,               -- Klartext, siehe Sicherheitsmodell
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_required BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMP NULL,
  reset_token_hash VARCHAR(64) NULL,
  reset_token_expires TIMESTAMP NULL,
  report_sub_period ENUM('none','week','month','quarter','year') NOT NULL DEFAULT 'none',
  report_sub_last_period_key VARCHAR(20) NULL,
  report_sub_last_sent_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL
);

CREATE TABLE tenants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meter_name VARCHAR(64) NOT NULL,            -- z.B. "WHG 1" - lose Kopplung, kein FK
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
  id CHAR(64) PRIMARY KEY,                    -- SHA-256-Hash des Session-Tokens, NIE das Token selbst
  user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INT NULL,                           -- NULL = Konto seither gelöscht (deleteUser())
  action VARCHAR(64) NOT NULL,                -- z.B. "tariff.set", "tenant.create", "login.failed",
                                               -- "report.subscription_self_sent" ...
  target VARCHAR(128) NULL,
  ip_address VARCHAR(45) NULL,                -- bei Cron-Läufen der Marker "cron" statt einer echten IP
  details JSON NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Freie Empfänger-Abos, NUR vom Vermieter (role='vermieter') anlegbar - siehe
-- "Periodischer Berichtsversand" unten für die volle Begründung.
CREATE TABLE report_subscriptions_custom (
  id INT AUTO_INCREMENT PRIMARY KEY,
  created_by_user_id INT NOT NULL,
  recipient_email VARCHAR(255) NOT NULL,
  period_type ENUM('week','month','quarter','year') NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_period_key VARCHAR(20) NULL,
  last_sent_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);
```

## Rollenmodell (wie tatsächlich implementiert — weicht vom ursprünglichen Konzept ab)

Die ursprüngliche Konzeptversion dieses Dokuments sah `verwaltung` als volle Admin-Rolle
und `vermieter` als rein lesend vor. **Umgesetzt wurde es umgekehrt**, auf ausdrücklichen
Wunsch: `role = 'vermieter'` ist die Admin-Rolle (`Auth::isAdmin()` prüft exakt das), mit
zusätzlich Benutzerverwaltung und den freien Empfänger-Abos; `role = 'verwaltung'` hat
vollen operativen Zugriff (Tarife, Mieter, Auswertungen, eigenes Abo) aber keine
Benutzerverwaltung.

| Rolle (DB-Wert) | Bezeichnung im UI | Rechte |
|---|---|---|
| `vermieter` | „Vermieter (Admin)" | Alles, inkl. `/benutzer.php`, freie Empfänger-Abos |
| `verwaltung` | „Verwalter" | Dashboard, Wohnungen, Tarife, eigenes Abo — kein `/benutzer.php` |

## Sicherheitsmodell (wie implementiert)

- **Passwörter:** `password_hash()`/`password_verify()` (PHP, bcrypt), Mindestlänge 12
  Zeichen (`Auth::changePassword()`).
- **TOTP:** eigene RFC-6238-Implementierung (`Totp.php`, kein externes Composer-Paket
  nötig), Secret **im Klartext** in `users.totp_secret` — gleiches Vertrauensmodell wie
  die übrigen Abrechnungsdaten: TLS-Transport + DB-Zugriffsschutz. Ein Admin kann TOTP pro
  Konto erzwingen (`totp_required`) — das Konto wird nach dem ersten Login zur Einrichtung
  gezwungen, bevor es irgendwo sonst hinkommt (`Auth::requireLogin()`).
- **Sessions:** serverseitig, `sessions.id` = SHA-256-Hash des Tokens (nie das Token
  selbst). Cookie: `HttpOnly`, `Secure`, `SameSite=Strict`. Logout und Passwort-Reset
  löschen alle Sessions des Kontos.
- **CSRF:** Token auf jedem Formular (`Csrf::field()`/`Csrf::verify()`), eigenes
  Session-Cookie (`abr_csrf`, getrennt vom Auth-Cookie `abr_session`).
- **Login-Schutz:** 3 Fehlversuche → 15 Minuten Sperre (`Auth::MAX_FAILED_ATTEMPTS`/
  `LOCKOUT_MINUTES`). Login-Fehlermeldung bewusst generisch ("Ungültige Anmeldedaten") für
  alle Fehlerfälle (falsches Passwort, unbekannter Account, gesperrt, deaktiviert) — kein
  Account-Enumeration möglich.
- **Passwort-Reset:** Token-basiert (`reset_token_hash`, 2h gültig, einmalig), Antwort
  bewusst identisch egal ob die E-Mail existiert oder nicht (`requestPasswordReset()`).
- **Verzeichnisschutz:** `private/.htaccess` blockt jeden direkten HTTP-Zugriff auf
  `private/` vollständig (`Require all denied`), unabhängig von Dateiendung oder
  PHP-Konfiguration — schützt `config.php` (Klartext-Credentials für DB/SMTP), den
  gesamten Quellcode unter `src/`, und das neue `cron/`-Verzeichnis samt Log-Datei.
  `.htaccess` im Webroot blockt zusätzlich `.sql`/`.md`-Dateien.
- **Fehlerbehandlung:** globaler `set_exception_handler()` in `bootstrap.php` — zeigt bei
  einer unerwarteten Exception eine generische Fehlerseite statt eines leeren weissen
  Bildschirms oder eines Stacktraces; die echte Fehlermeldung landet nur im Server-Log.
- **Audit-Log:** jede sicherheits-/abrechnungsrelevante Aktion wird protokolliert (Logins,
  Tarifänderungen, Mieterverwaltung, Benutzerverwaltung, Berichtsversand inkl. Abo-Mails).

## Seiten (v1, tatsächlich implementiert)

```
/login.php                      Anmeldung (+ TOTP-Schritt, falls aktiviert)
/passwort-vergessen.php         Passwort-Reset anfordern
/passwort-zuruecksetzen.php     Neues Passwort setzen (Token-Link aus der E-Mail)
/dashboard.php                  Gebäudeübersicht, Zeitraumauswahl, Warnung bei zu wenig Daten,
                                 manueller Nachversand
/wohnungen.php                  Liste aller Wohnungen/Zähler + Detailansicht (Mieter,
                                 Verlauf 12 Monate, Berechnungsmethode-Badge)
/tarife.php                     Tarifhistorie + Bulk-Set, Umlagekosten (mit Bezeichnung)
/benutzer.php                   Benutzerverwaltung + Audit-Log (nur Vermieter/Admin)
/einstellungen.php              Passwort ändern, TOTP ein/aus, eigenes Berichts-Abo,
                                 freie Empfänger-Abos (nur Vermieter/Admin)
```

Kein separates `/auswertungen` — die Zeitraum-Auswahl (Tag/Woche/Monat/Quartal/Jahr) auf
Dashboard und Wohnungen deckt das dynamische Auswertungsbedürfnis bereits ab
(`Period::resolve()`).

### Warnung bei unzureichender Datenabdeckung

`Period::renderCoverageWarning()` vergleicht die Anzahl Tage mit tatsächlichen Daten
gegen die Anzahl Kalendertage des gewählten Zeitraums (`Period::expectedDays()`) und
rendert einen deutlich sichtbaren Banner (nicht nur einen kleinen Hinweistext), sobald das
auseinanderfällt — z.B. direkt nach einem Datenreset zeigt "Quartal" sonst nur die Summe
weniger Tage, was für ein ganzes Quartal völlig unplausibel wirkt. Bewusst EINE
Formulierung für den gesamten Bereich von 0 bis "fast vollständig" ("zu wenig Daten"),
keine separate Copy für den Sonderfall "keine Daten" — der Null-Fall ist nur das eine Ende
dieser Skala, in der Praxis überwiegt der Teil-Abdeckungsfall deutlich.

## Periodischer Berichtsversand (E-Mail-Abos)

Zwei bewusst getrennte Mechanismen (siehe `private/migrations/005_report_subscriptions.sql`
für die volle Begründung):

1. **Eigenes Abo** — jeder eingeloggte Benutzer (Verwalter wie Vermieter) kann sich selbst
   auf `/einstellungen.php` für ein Intervall eintragen (wöchentlich/monatlich/
   quartalsweise/jährlich). Versand geht **immer** an die eigene Kontoadresse — kein
   beliebiger Empfänger, analog zum bereits bestehenden manuellen Nachversand-Button auf
   dem Dashboard. Felder direkt auf `users` (`Subscriptions::setSelfSubscription()`).
2. **Freie Empfänger-Abos** — **nur** für `role='vermieter'`. Erlaubt den automatischen
   Versand an eine beliebige E-Mail-Adresse (z.B. eine Verwaltung oder ein Treuhänder, dem
   der Vermieter kein eigenes Login geben will), beliebig viele parallel, pausierbar und
   löschbar (`report_subscriptions_custom`, `Subscriptions::createCustom()`/
   `setCustomActive()`/`deleteCustom()`).

### Wann wird verschickt?

`Period::lastCompletedPeriod($type)` berechnet immer den zuletzt **abgeschlossenen**
Zeitraum relativ zu heute (z.B. am 21.08. liefert `month` → Juli, `quarter` → Q2, nie den
laufenden Zeitraum) — unabhängig davon, an welchem Wochentag der Cron tatsächlich läuft.
Jede Zeile (Benutzer-Abo oder freies Abo) merkt sich den zuletzt versendeten Zeitraum als
stabilen Schlüssel (`last_period_key`, z.B. `"month:2026-07"`). `Subscriptions::runDue()`
verschickt nur, wenn der aktuell fällige Schlüssel vom gespeicherten abweicht — dadurch
ist mehrfaches Laufen am selben Tag (oder ein nachgeholter Lauf nach Ausfall) unkritisch,
es wird nie doppelt verschickt, und es werden auch keine mehrfach verpassten Perioden
nachgeliefert (nur die zuletzt abgeschlossene).

### Cron-Job

```
0 5 * * * php /home/swisslin/public_html/abr.bronnenhuber.ch/private/cron/send_subscriptions.php \
  >> /home/swisslin/public_html/abr.bronnenhuber.ch/private/cron/send_subscriptions.log 2>&1
```

Läuft täglich um 05:00 (nach der nächtlichen ioBroker-Akkumulation um 23:58, damit der
Vortag garantiert vollständig in `meter_daily`/`building_daily` steht). Eingerichtet via
`crontab -e` auf dem Cyon-Account (kein separates Cyon-Panel-Cronjob nötig — SSH-Crontab
ist auf diesem Paket verfügbar und wird bereits für Nextcloud/Backup genutzt). Das Skript
verweigert die Ausführung ausserhalb der CLI (`PHP_SAPI !== 'cli'` → 403) — es kann also
nie über eine HTTP-Anfrage ausgelöst werden, selbst falls `private/.htaccess` je entfernt
würde. Log-Datei liegt unter `private/cron/` und ist damit ebenfalls durch
`private/.htaccess` von aussen unerreichbar.

### Berichtsinhalt

`ReportMail::sendReport()` (Refactoring von `sendToSelf()`, gleiche Kernlogik) baut
dasselbe zweiseitige XLSX wie der manuelle Nachversand und wie der Adapter selbst — siehe
[BILLING.md](BILLING.md) "Report format parity" für die Garantie, dass Adapter- und
Webapp-Bericht identisch sind.

## Technologie

- **Backend:** PHP 8.3, kein Framework — eigener schlanker Satz an `public/*.php`-
  Einstiegspunkten + PDO-Klassen unter `private/src/`, Autoloading über einen simplen
  `spl_autoload_register()` in `bootstrap.php` (kein Composer nötig).
- **Frontend:** serverseitig gerendertes PHP, minimales Vanilla-JS nur für den TOTP-QR-Code
  (`qrcode.js`) — kein Node-Build-Prozess, läuft auf Standard-Shared-Hosting.
- **Export:** eigener minimaler XLSX-Writer (`XlsxWriter.php`, OOXML via `ZipArchive`) —
  bewusst kein PhpSpreadsheet, um mit dem Adapter-Format (ExcelJS) 1:1 mitzuhalten, ohne
  eine schwere Fremdbibliothek für zwei einfache Tabellenblätter.

## Deployment

Kein CI/CD — Dateien werden manuell per `scp` auf den Cyon-Host kopiert (Layout:
`private/`, `assets/`, und die `public/*.php`-Dateien liegen DIREKT im Webroot
`public_html/abr.bronnenhuber.ch/`, nicht unter einem `public/`-Unterordner — das lokale
Repo hat sie zur Klarheit trotzdem in einem `public/`-Ordner strukturiert). DB-Migrationen
werden manuell per einmaligem PHP-Skript über `Database::pdo()` angewendet, siehe README.md
im Webapp-Repo für den genauen Ablauf.

## Spätere Phase (v2, nicht priorisiert)

- Rechnungen/Gutschriften inkl. Schweizer QR-Zahlteil.
- Mieter-Zugang (eigener Login pro Wohnung, nur eigene Daten sichtbar).
- 80 %-Solartarif-Prüfung (Art. 16b Abs. 2 EnV) als Warnhinweis bei der Tarifverwaltung.
- CI/CD statt manuellem `scp`-Deploy; automatisierter Migrationsrunner statt Ad-hoc-Skripten.
