# Code-Review Abrechnungssystem Trimmis, Stand 2026-10-01

Geprüft wurden der ioBroker-Adapter `iobroker.solarlog` (Version 2.5.20, danach 2.5.21) und die
Webapp `abr.bronnenhuber.ch` (Repo `_abr_billing_webapp`). Grundlage ist der Quelltext, ergänzt durch
Prüfungen am laufenden System (HTTP-Abfragen, Datenbankabfragen, Inspektion eines versendeten Berichts).

**Geprüft:** `main.js` (Nachtlauf, Tarife, DB-Anbindung, Berichtsversand, Nachrichten-Handler),
`lib/*` (db, report, pendingQueue, pendingDelivery, scheduling, validation, billing, dates),
alle PHP-Klassen und Seiten der Webapp, Cron, `.htaccess`, Konfiguration.
**Nicht oder nur oberflächlich geprüft:** das Parsen der Solar-Log-Antworten (`readSolarlogData`),
`tools/backfill-from-influx.js` (nur Aufruf und Schutzflag gesichtet), CSS/JS-Assets, Cloudflare-Konfiguration.

Statuswerte: **behoben** (Code geändert, getestet, ausgerollt), **offen** (Entscheid oder grösserer Umbau nötig).

## Gesamteindruck

Die Grundlagen sind solide: Alle SQL-Abfragen sind parametrisiert (keine Interpolation gefunden), die
Ausgabe ist escaped, alle POST-Formulare prüfen ein CSRF-Token, Passwörter liegen als bcrypt-Hash vor,
Reset-Tokens sind gehasht, einmalig und befristet, der letzte Admin ist geschützt, Zugangsdaten im
Adapter sind verschlüsselt (`encryptedNative`), die Schreibvorgänge in die Datenbank sind idempotent.

Die gravierendsten Probleme liegen nicht in der Technik der Seiten, sondern in der **Abrechnungslogik**:
Tarife wirkten nicht rückwirkend (F-13, behoben), Berichte konnten unvollständig als vollständig erscheinen
(behoben, F-09) und der Beispieltarif wurde bisher stillschweigend verrechnet (F-11).

## Behoben

| ID | Schwere | Befund | Massnahme |
|----|---------|--------|-----------|
| F-01 | hoch | `https://abr.bronnenhuber.ch/error_log` war öffentlich lesbar (HTTP 200) und zeigte DB-Benutzername und Serverpfade. Live bestätigt. | `.htaccess` sperrt `error_log`, `*.log`, Sicherungsdateien. Danach HTTP 403. |
| F-02 | hoch | Zwischenspeicher: Lief der 10-Minuten-Nachlieferjob gleichzeitig mit dem Nachtlauf, konnte er den Puffer mit einer veralteten Kopie überschreiben und eine frisch gepufferte Nacht löschen. | Alle Puffer-Änderungen laufen nacheinander und lesen den Puffer in der Sperre neu. Entfernt wird nur der gelieferte Eintrag (Datum und `queuedAt`). 3 neue Tests, die mit dem alten Code scheitern. |
| F-03 | mittel | Blatt `Gebaeude` des Adapter-Berichts enthielt alle Zahlen als Text (der Treiber liefert DECIMAL als String). Im versendeten Septemberbericht bestätigt. Widersprach der Vorgabe, dass Adapter- und Webapp-Bericht identisch sind. | Werte werden als Zahlen geschrieben. Test ergänzt. |
| F-04 | hoch | Abo-Cron setzte `last_period_key` auch nach fehlgeschlagenem Versand. Ein Bericht, der wegen SMTP-Ausfall um 05:00 nicht ankam, ging dauerhaft verloren (der Cron meldet nichts, `MAILTO` ist leer). | Der Schlüssel wird nur nach erfolgreichem Versand gesetzt, ein gescheiterter Bericht wird am nächsten Tag erneut versucht. |
| F-05 | mittel | TOTP-Schritt ignorierte die Kontosperre. Mit einem offenen Pending-Marker waren im 5-Minuten-Fenster unbegrenzt Codeversuche möglich. | Sperre gilt auch im TOTP-Schritt, die ausstehende Anmeldung wird bei Sperre verworfen. |
| F-06 | mittel | Links in Reset- und Willkommensmails wurden aus dem `Host`-Header gebaut. Ein gefälschter Header hätte dem Opfer einen Link auf eine fremde Domain mit gültigem Token geschickt. | Basis-URL aus `config.php` (`base_url`) mit Produktiv-Fallback. Auf dem Server gegen gefälschten Host getestet. |
| F-07 | niedrig | Login antwortete bei unbekannter Adresse schneller als bei bekannter (kein bcrypt). Die Fehlermeldung war zwar gleich, die Antwortzeit verriet aber, ob ein Konto existiert. | Scheinprüfung gegen einen Dummy-Hash. |
| F-08 | niedrig | Ein Konto mit Pflicht-TOTP konnte TOTP selbst wieder abschalten. | Bei `totp_required` nicht deaktivierbar. |
| F-09 | hoch | Berichte für Zeiträume mit fehlenden Tagen sahen vollständig aus. Der am 01.10. versendete Septemberbericht enthielt nur 15 Tage im Blatt `Gebaeude`. | Adapter und Webapp kennzeichnen solche Berichte mit `[UNVOLLSTAENDIG]` in Betreff und Text (inklusive Liste der Tage) und der Adapter loggt einen Fehler. Geprüft wird pro Zähler, nicht nur pro Tag. |
| F-10 | mittel | Fällt der Nachtlauf (23:58) aus, weil Adapter, VM oder Solar-Log aus waren, entsteht keine Zeile und niemand erfährt es. Der Puffer greift erst nach dem Bauen der Zeile. | Fehlermeldung im Log um 00:10 und beim Start, wenn der Vortag fehlt. Erkennung, keine automatische Reparatur. Wiederherstellung per `tools/backfill-from-influx.js`. |
| F-11 | hoch | Es wurde nie ein echter Tarif gesetzt: `tariff_schedule` enthielt nur eine Test-Zeile. Alle Tage seit 10.08. wurden mit dem eingebauten Beispieltarif 0.28 / 0.20 CHF/kWh verrechnet, ohne Hinweis. | Der Adapter loggt jede Nacht eine Warnung, solange für den Monat kein Tarif gesetzt ist. **Der Eigentümer muss die echten Tarife eintragen, das wirkt seit F-13 auch rückwirkend.** |
| F-12 | niedrig | Kleinere Härtungen: `JSON_HEX_*` beim Einbetten der TOTP-URI in ein Script, abgelehntes `ensurePool()` bricht die Nacht nicht mehr ab, ein unlesbarer Puffer wird als Fehler geloggt statt stillschweigend geleert. | Umgesetzt. |
| F-13 | hoch | Tarifänderungen wirkten nicht rückwirkend (ehemals O-01). Die Tageszeilen speichern den Tarif des Schreibtags, Berichte nahmen den der letzten Zeile für den ganzen Monat. Ein nach Monatsende gesetzter Tarif änderte den Bericht nicht, ein mitten im Monat gesetzter galt im Bericht für den ganzen Monat, auf dem Bildschirm nur ab diesem Tag. | Der Tarif aus `tariff_schedule` gilt für den ganzen Kalendermonat, in den Berichten beider Systeme und in allen CHF-Summen der Webapp. Monate ohne Eintrag behalten den Tagestarif. Adapter 2.5.22 (3 neue Tests), Webapp. Auf den echten Daten mit einem Testtarif in einer zurückgerollten Transaktion geprüft. |
| F-14 | mittel | Dashboard und Wohnungsseite summierten die gerundeten Tagesbeträge, der Bericht rechnet aus den gerundeten Monats-kWh (ehemals O-02). September: 393.43 gegen 393.46 CHF. | Eine gemeinsame Berechnung (`Reports::energyCostByMeter()`). Zusätzlich enthält das Audit-Log einer Tarifänderung jetzt den vorherigen Wert, die Sammeländerung läuft in einer Transaktion und das Jahr ist auf 2000 bis 2100 begrenzt. |

Ausgerollt: Adapter 2.5.22 (Commit d76715b, 123 Tests grün), Webapp (Commits 06334e0 und 960d4c9).
Die Webapp-Dateien wurden vorher gesichert (`~/webapp_backup_20261001/` auf Cyon).

## Offen

### Abrechnungslogik

O-01 (rückwirkende Tarife) und O-02 (zwei verschiedene CHF-Beträge) sind am selben Abend behoben, siehe F-13 und F-14.

**O-03 (hoch, nur aus dem Code, nicht live nachgestellt): Veraltete Gerätewerte werden als voller Tag verbucht.**
Der Nachtlauf liest `status.yieldday`, `status.consyieldday` und `INV.<Zähler>.daysum` ohne Prüfung, wie alt diese Werte
sind. War das Solar-Log ab Mittag nicht erreichbar, wird der letzte Stand als Tageswert geschrieben. Eine geringe
Abdeckung schaltet nur auf `tagesnetto` um, markiert die Zeile aber nicht als unsicher.
*Empfehlung:* Zeitstempel (`ts`) der Werte prüfen und bei Alter über etwa 30 Minuten die Zeile als unsicher
kennzeichnen (neue Spalte oder Methode `unsicher`) und einen Fehler loggen.

**O-04 (mittel): Zähler ohne `daysum` werden im Nachtlauf stillschweigend übersprungen** (`continue`). Es entsteht eine
halbe Tageszeile. Seit F-09 fällt das in Berichten auf, die Ursache bleibt aber unsichtbar im Log.

**O-05 (mittel): Systematische Unterschätzung und fragile Monatsgrenze.** Der Nachtlauf läuft um 23:58, die letzten zwei
Minuten des Tages fehlen (das sind 0.14 % der Tagesdauer, die Auswirkung auf den Verbrauch ist entsprechend klein, aber immer in dieselbe Richtung). Die ioBroker-Monatszähler und das Monatsarchiv wechseln erst im
Lauf des 1. um 23:58, also einen Tag nach der Monatsgrenze, und nur wenn dieser Lauf stattfindet. Die Berichte hängen
nicht daran (sie lesen aus MariaDB), die Archiv-States aber schon.
*Empfehlung:* Lauf um 23:59:30 oder zwei Läufe dokumentieren, und die Monatszähler aus der Datenbank ableiten.

**O-06 (mittel): Der Adapterbericht wird nur einmal um 00:10 versucht.** Ist MariaDB oder der Mailserver dann nicht
erreichbar oder der Adapter gerade im Neustart, wird der Bericht nicht nachgeholt (die Webapp wiederholt seit F-04).
*Empfehlung:* gleiche Logik wie in der Webapp, mit gemerktem `last_period_key` in einem State.

**O-13 (mittel, funktional): Mieter sind nicht mit der Abrechnung verknüpft.** Berichte sind pro Wohnung und Monat. Ein
Mieterwechsel mitten im Monat ergibt eine gemeinsame Zeile. `mietbeginn` und `mietende` werden nicht ausgewertet.

**O-16 (niedrig): `Tarif.default.*` ist wirkungslos.** `ensureAllMonthlyTariffsUntil(2035)` legt für jeden Monat einen State
mit dem Konstantenwert an, und `getTariffsForMonth()` liest zuerst diesen Monatsstate. Eine Änderung des Standardtarifs
erreicht diese Monate nie.

### Sicherheit und Nachvollziehbarkeit

**O-07 (mittel): Audit-Log.** (a) Beim Löschen eines Benutzers geht die Zuordnung seiner Aktionen verloren (`user_id`
wird NULL). Besser: E-Mail des Handelnden als Text mitspeichern. (b) Tarifänderungen protokollieren nur den neuen,
nicht den alten Wert. (c) `REMOTE_ADDR` ist hinter Cloudflare die Cloudflare-Adresse, nicht die des Benutzers; die
IP im Audit-Log hat so kaum Aussagekraft (Auswertung von `CF-Connecting-IP` nur für Anfragen aus den Cloudflare-Netzen).
(d) Keine Aufbewahrungs- und Löschregel.

**O-08 (mittel): TOTP.** Das Secret liegt im Klartext in `users.totp_secret` (Verschlüsselung mit einem Schlüssel aus
`config.php` wäre möglich). Es gibt keine Wiederherstellungscodes und einen Code kann man innerhalb seines
30-Sekunden-Fensters mehrfach verwenden.

**O-09 (niedrig):** Bestehende Sitzungen bleiben nach Passwortänderung gültig (nur der Reset löscht sie). Abgelaufene
Sitzungen werden nie gelöscht. Es gibt keine IP-Begrenzung, jeder Fehlversuch schreibt eine Zeile in `audit_log`, und die
Kontosperre lässt sich durch drei Fehlversuche von aussen auslösen.

**O-10 (niedrig): SMTP-Client.** Textkörper mit nacktem LF statt CRLF, kein Socket-Timeout. Wegen fehlender Möglichkeit,
den Versand gefahrlos zu testen, in dieser Runde nicht geändert.

**O-11 (niedrig):** `private/` (mit `config.php`) liegt unter dem Webroot und ist nur durch `.htaccess` geschützt
(HTTP 403 bestätigt). Besser ausserhalb des Webroots. In `private/` liegt eine Sicherung `config.php.bak-before-solarlog-db-...`
mit dem alten Passwort: nach ein paar Tagen löschen, ebenso den SQL-Dump im Home-Verzeichnis.

**O-12 (niedrig):** Kein `Content-Security-Policy` und keine `Permissions-Policy`. Vorhanden und in Ordnung: HSTS,
`X-Frame-Options`, `nosniff`, Referrer-Policy, Cookie-Flags (`Secure`, `HttpOnly`, `SameSite=Strict`).

### Weiteres

**O-14 (niedrig): Eingabeprüfung.** Datumsfelder prüfen nur das Muster (`2026-13-45` führt zu einem Datenbankfehler und
der allgemeinen Fehlerseite). Jahr ist bei Tarif und Umlagekosten nicht begrenzt. Die Sammelfunktionen für Tarife und
Umlagekosten laufen nicht in einer Transaktion, ein Fehler mitten im Zeitraum hinterlässt einen Teilzustand. Die
Wochenauswahl verwendet um den Jahreswechsel das Kalenderjahr statt des ISO-Jahres.

**O-15 (prüfen):** Der Adapter löscht Kopien versendeter Berichte nach 365 Tagen. Ob für Abrechnungsunterlagen eine
längere Aufbewahrung gilt (bei Geschäftsunterlagen im Obligationenrecht zehn Jahre), sollte fachlich geklärt werden. Die
Datenbank selbst löscht nichts.

**O-18 (mittel): Testabdeckung.** Die Libs des Adapters haben 120 Unit-Tests. Der Nachtlauf in `main.js`
(`accumulateMonthlyPerDevice`, die wichtigste Funktion des Systems) hat keine automatischen Tests, die Webapp gar keine
(nur ein TOTP-Vektortest). Vor Änderungen an O-01, O-03 und O-05 sollten zuerst Tests für diese Teile entstehen.

## Empfohlene Reihenfolge

1. Die echten Tarife für August und September in der Webapp eintragen (wirken jetzt rückwirkend) und die Berichte neu versenden.
2. O-03 (veraltete Werte) und O-04 (fehlende `daysum`).
3. O-06 (Wiederholung des Adapterberichts).
4. O-07 bis O-09 (Audit und TOTP), O-11 (Sicherungen entfernen).
5. O-18 Tests für den Nachtlauf, danach O-05.
