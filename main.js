'use strict';
/**
 * solarlog adapter
 */
/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const axios = require('axios');
const https = require('node:https');
const schedule = require('node-schedule');
const bcrypt = require('bcryptjs');
const { selfConsumptionRatio } = require('./lib/billing');
const mariadb = require('mariadb');
const {
    buildMeterDailyRow,
    buildBuildingDailyRow,
    ensureSchema,
    upsertMeterDaily,
    upsertBuildingDaily,
    queryMeterPeriod,
    queryBuildingPeriod,
} = require('./lib/db');
const { buildReportWorkbook, buildReportFileName } = require('./lib/report');
const { determineScheduledPeriod } = require('./lib/scheduling');

let adapter;

let deviceIpAddress;
let port;
const cmd = '/getjp'; // Kommandos in der URL nach der Host-Adresse

let requestCounter = 0;
let dataToken = '';

let optionsDefault = {};
let optionsJson = {};
let statusuz = 'on';

let deviceList = [];
let brandlist = [];
const deviceClassList = [
    'Wechselrichter',
    'Sensor',
    'Zähler',
    'Hybrid-System',
    'Batterie',
    'Intelligente Verbraucher',
    'Schalter',
    'Wärmepumpe',
    'Heizstab',
    'Ladestation',
];
let numinv = 0;
const names = [];
let numsg = 0;
const namessg = new Array(10);

const deviceinfos = [];
const devicetypes = [];
const devicebrands = [];
const deviceclasses = [];

let json = [];
let lastdaysumy = 99;
let lastdayratioy = 99;

let uzimp;
let battDevicePresent = false;
let battPresent = false;
const battindex = [];
let battarrind = 0;
let battdata = [];
let testend;
let testj = 0;
let testi = 0;
let feed = 0;

let historic = false;
let histCRON = '0 0 * * *';

let forecast = false;
const urlForecast = 'https://api.forecast.solar/';
let cmdForecast;
let lat;
let lon;
let dec;
let az;
let kwp;

let userPass = false;
let installerPass = false;
let loginLevel = null; // null | 'user' | 'installer'
// let loginData = '';

const startupData = `{"152":null,"161":null,"162":null,"447":null,"610":null,"611":null,"617":null,"706":null,"739":null,"740":null,"744":null,"800":{"100":null,"160":null},"801":{"101":null,"102":null},"858":null,"895":{"100":null,"101":null,"102":null,"103":null,"104":null,"105":null}}`;
const inverterDataArray = [];
const pollingData = '{"447":null,"777":{"0":null},"778":{"0":null},"801":{"170":null}}';
const historicData = '{"854":null,"877":null,"878":null}';
const fastpollData = '{"608":null,"780":null,"781":null,"782":null,"794":{"0":null},"801":{"175":null},"858":null}';
const historicDataJSONmonths = '/months.json?_=';
const historicDataJSONyears = '/years.json?_=';
let polling;
let fastPolling;

let jedeStunde;
let jedenTag;
let jedeNacht;
let reportCheckJob;
let restartTimer;
let mariadbPool = null;

let userName;
let userPw;
let installerPw;

let backupAuto = false;
let backupKeep = 5;
let weeklyBackup;
let backupRunning = false;

function unload(callback) {
    try {
        restartTimer && clearTimeout(restartTimer);
        restartTimer = null;

        jedeStunde && jedeStunde.cancel();
        jedeStunde = null;

        weeklyBackup && weeklyBackup.cancel();
        weeklyBackup = null;

        jedenTag && jedenTag.cancel();
        jedenTag = null;

        jedeNacht && jedeNacht.cancel();
        jedeNacht = null;

        reportCheckJob && reportCheckJob.cancel();
        reportCheckJob = null;

        if (mariadbPool) {
            mariadbPool.end().catch(() => {});
            mariadbPool = null;
        }

        polling && clearInterval(polling);
        polling = null;

        fastPolling && clearInterval(fastPolling);
        fastPolling = null;

        testend && clearInterval(testend);
        testend = null;

        adapter.setState('info.connection', false, true);
        adapter.log && adapter.log.info('[END] Stopping solarlog adapter...');
        callback && callback();
    } catch {
        adapter.log && adapter.log.warn('[END 7 catch] adapter stopped ');
        callback && callback();
    }
}

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: 'solarlog',
    });

    adapter = new utils.Adapter(options);

    // when adapter shuts down
    adapter.on('unload', callback => unload(callback));

    // is called when databases are connected and adapter received configuration.
    adapter.on('ready', async () => {
        try {
            if (adapter.config.host) {
                adapter.log.info('[START] Starting solarlog adapter');
                await adapter.setStateAsync('info.connection', true, true);
                // File storage root for Backup.*/Export.* - required before the first
                // writeFileAsync/readDirAsync call, js-controller does not create it implicitly.
                // Uses setForeignObjectNotExistsAsync because the target id IS the bare
                // namespace itself, not a state relative to it.
                await adapter.setForeignObjectNotExistsAsync(adapter.namespace, {
                    type: 'meta',
                    common: { name: adapter.namespace, type: 'meta.folder' },
                    native: {},
                });
                await main();
            } else {
                adapter.log.warn('[START] No IP-address set');
            }
        } catch (e) {
            adapter.log.warn(`on.Ready - Error: ${e.message}`);
        }
    });

    return adapter;
} // endStartAdapter

async function main() {
    try {
        port = adapter.config.port;
        // Vars
        adapter.log.debug(`Host? ${adapter.config.host.includes('http')} : ${adapter.config.host}`);
        if (adapter.config.host.includes('http')) {
            deviceIpAddress = adapter.config.host;
        } else {
            deviceIpAddress = `http://${adapter.config.host}:${port}`;
        }

        if (deviceIpAddress.substr(-1) == '/') {
            deviceIpAddress = deviceIpAddress.substr(0, deviceIpAddress.length - 1);
        }

        adapter.log.info(`Solarlog IPaddress: ${deviceIpAddress}`);
        await ensureFeedinDayObject();
        await ensureMariaDbPool();

        //cmd = '/getjp'; // Kommandos in der URL nach der Host-Adresse
        numinv = 0;
        uzimp = !!adapter.config.invimp;
        forecast = !!adapter.config.forecast;
        historic = !!adapter.config.historic;
        histCRON = `${adapter.config.histmin} ${adapter.config.histhour} * * *`;
        userPass = !!adapter.config.userpass;
        userPw = adapter.config.userpw;
        installerPass = !!adapter.config.installerpass;
        installerPw = adapter.config.installerpw;
        backupAuto = !!adapter.config.backupAuto;
        backupKeep = parseInt(adapter.config.backupKeep, 10) || 5;

        // Installer login is a superset of user login (grants access to additional values),
        // so it takes precedence when both are configured.
        if (installerPass) {
            userName = 'installer';
            loginLevel = 'installer';
        } else if (userPass) {
            userName = 'user';
            loginLevel = 'user';
        } else {
            userName = 'user';
            loginLevel = null;
        }
        optionsDefault = {
            method: 'post',
            headers: {
                Accept: '*/*',
                'Accept-Encoding': 'gzip, deflate',
                //'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                Connection: 'keep-alive',
                //'Content-Length': data.length,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                Referer: `${deviceIpAddress}/`,
                'Accept-Origin': `${deviceIpAddress}/`,
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
                'X-SL-CSRF-PROTECTION': '1',
                Cookie: `banner_hidden=false; SolarLog=${dataToken}`,
            },
        };

        optionsJson = {
            //port,
            method: 'get',
            headers: {
                Accept: '*/*',
                'Accept-Encoding': 'gzip, deflate',
                //'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                Connection: 'keep-alive',
                //'Content-Length': data.length,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                Referer: `${deviceIpAddress}/`,
                'Accept-Origin': `${deviceIpAddress}/`,
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
                Cookie: `banner_hidden=true; SolarLog=${dataToken}`,
            },
        };

        adapter.log.info(`subdivice Import: ${adapter.config.invimp}`);
        adapter.log.debug(`uzimp: ${uzimp}`);
        if (historic) {
            adapter.log.info(`Getting historic data @ ${adapter.config.histhour}:${adapter.config.histmin}`);
        } else {
            adapter.log.info('Historc data diabled');
        }
        adapter.log.info(`Getting forecast data: ${forecast}`);
        const pollingTimecurrent = adapter.config.pollIntervalcurrent * 1000 || 30000;
        const pollingTimeperiodic = adapter.config.pollIntervalperiodic * 1000 || 30000; // seconds (fixed 2026-08: was minutes, inconsistent with pollIntervalcurrent and the also-broken admin field id)
        adapter.log.debug(`[INFO] Configured polling interval consumption/production: ${pollingTimecurrent}`);
        adapter.log.debug(`[INFO] Configured polling interval averages&other: ${pollingTimeperiodic}`);
        adapter.log.debug(`[START] Started Adapter with: ${adapter.config.host}`);

        if (loginLevel) {
            await login();
        }

        if (uzimp) {
            adapter.log.debug(`uzimp: ${uzimp}`);
            adapter.log.debug('Import inverters/WR');

            setTimeout(async () => await logCheck(startupData), 500);

            testend = setInterval(async () => await test(), 2000); // Überprüfen, ob alle Channels angelegt sind.

            fastPolling = fastPolling || setInterval(async () => await logCheck(fastpollData), pollingTimecurrent); // poll states every pollIntervalcurrent seconds (removed the +20000ms fixed offset 2026-08: made the actual cadence silently 20s slower than configured)

            polling = polling || setInterval(async () => await logCheck(pollingData), pollingTimeperiodic); // poll states every [30] seconds
        } else {
            adapter.log.debug(`uzimp: ${uzimp}`);
            adapter.log.debug('Not importing inverters/WR');
            if (forecast) {
                await setForecastObjects();
            } else {
                await logCheck('{"801":{"170":null}}');
            }

            polling = polling || setInterval(async () => await logCheck('{"801":{"170":null}}'), pollingTimecurrent); // poll states every [30] seconds
        }

        jedenTag = schedule.scheduleJob(histCRON, async () => {
            if (historic) {
                adapter.log.info('Getting long term data');
                const obj = await adapter.getStateAsync('info.Model');
                if (obj) {
                    const slmodel = parseInt(obj.val, 10);
                    adapter.log.debug(`Solarlog model ${slmodel}`);
                    if (slmodel === 500) {
                        await logCheck('{"854": null}');
                        setTimeout(async () => await logCheck(historicDataJSONmonths), 2000);
                        setTimeout(async () => await logCheck(historicDataJSONyears), 7000);
                    } else {
                        await logCheck(historicData);
                    }
                }
            } else {
                adapter.log.debug('Historc data not activated');
            }
        });

        jedeStunde = schedule.scheduleJob('25 * * * *', async () => {
            adapter.log.debug('Getting forecast data');
            if (forecast) {
                await getForecastData();
            }
        });

        if (uzimp) {
            jedeNacht = schedule.scheduleJob('58 23 * * *', async () => accumulateMonthlyPerDevice());
            await ensureAllMonthlyTariffsUntil(2035);
        }

        // Runs once/day, well after midnight so "today" has fully rolled over for the
        // cutoff-day check in lib/scheduling.js.
        reportCheckJob = schedule.scheduleJob('10 0 * * *', async () => checkAndSendScheduledReport());

        if (backupAuto) {
            weeklyBackup = schedule.scheduleJob('0 3 * * 0', async () => {
                if (await hasPlantDataChangedSinceLastBackup()) {
                    adapter.log.info('Starting scheduled weekly backup (plant data changed)');
                    await runBackup();
                } else {
                    adapter.log.info('Skipping scheduled backup - no change since last backup');
                }
            });
        }

        adapter.subscribeStates('Backup.trigger');
        adapter.subscribeStates('Export.triggerMeterReadings');
        adapter.on('stateChange', async (id, state) => {
            if (!state || state.ack) {
                return;
            }
            if (id === `${adapter.namespace}.Backup.trigger`) {
                await adapter.setStateAsync('Backup.trigger', false, true);
                await runBackup();
            } else if (id === `${adapter.namespace}.Export.triggerMeterReadings`) {
                await adapter.setStateAsync('Export.triggerMeterReadings', false, true);
                await regenerateCurrentReport();
            }
        });
    } catch (e) {
        adapter.log.warn(`main - Error: ${e.message}`);
    }
} // endMain

async function getPlantSignature() {
    const yieldTotal = await adapter.getStateAsync('status.yieldtotal');
    const consTotal = await adapter.getStateAsync('status.consyieldtotal');
    return `${yieldTotal ? yieldTotal.val : ''}|${consTotal ? consTotal.val : ''}`;
} // END getPlantSignature

async function hasPlantDataChangedSinceLastBackup() {
    try {
        const lastSigState = await adapter.getStateAsync('Backup.lastSignature');
        if (!lastSigState || !lastSigState.val) {
            return true; // no previous backup recorded
        }
        const currentSignature = await getPlantSignature();
        return currentSignature !== lastSigState.val;
    } catch (e) {
        adapter.log.debug(`hasPlantDataChangedSinceLastBackup - Error, backing up to be safe: ${e.message}`);
        return true;
    }
} // END hasPlantDataChangedSinceLastBackup

async function runBackup() {
    if (backupRunning) {
        adapter.log.warn('Backup already running, ignoring new trigger');
        return;
    }
    if (!installerPass) {
        adapter.log.warn('Backup requires installer login - enable it in the adapter settings first');
        await adapter.setStateAsync('Backup.status', 'error', true);
        await adapter.setStateAsync('Backup.lastError', 'installer login required', true);
        return;
    }

    backupRunning = true;
    await adapter.setStateAsync('Backup.status', 'running', true);
    await adapter.setStateAsync('Backup.progress', 0, true);
    await adapter.setStateAsync('Backup.lastError', '', true);

    try {
        await login();

        // The device requires an active installer session and rejects the backup
        // endpoints without CSRF header + Referer, unlike the regular polling calls.
        // Built AFTER login() so it picks up the freshly issued session token.
        const backupOptions = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                Accept: '*/*',
                'X-Requested-With': 'XMLHttpRequest',
                'X-SL-CSRF-PROTECTION': '1',
                Referer: `${deviceIpAddress}/`,
                Cookie: `banner_hidden=false; SolarLog=${dataToken}`,
            },
        };

        // axios silently mis-serializes a plain object body when Content-Type is
        // urlencoded (the device then sees an empty request) - send raw JSON text
        // instead, matching what the device's own web UI sends.
        const start = await axios.post(`${deviceIpAddress}/getjp`, JSON.stringify({ 715: null }), backupOptions);
        const startResult = start?.data?.['715'];
        if (startResult !== 'OK') {
            throw new Error(`Backup could not be started: ${JSON.stringify(startResult)}`);
        }
        adapter.log.info('Backup export started on the Solar-Log device');

        // Backup export runs on-device (state 715 -> polling 801.777/778 -> state 3 = done).
        // Large installations (years of minute-data) can take several minutes.
        const timeoutMs = 15 * 60 * 1000;
        const pollIntervalMs = 3000;
        const deadline = Date.now() + timeoutMs;
        let done = false;

        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            const poll = await axios.post(
                `${deviceIpAddress}/getjp`,
                JSON.stringify({ 801: { 777: null, 778: null } }),
                backupOptions,
            );
            const state801 = poll?.data?.['801'] || {};
            const stateCode = state801['777'];

            if (stateCode === 3) {
                done = true;
                await adapter.setStateAsync('Backup.progress', 100, true);
                break;
            }
            if (stateCode === -7 || stateCode === -9 || stateCode === 98 || stateCode === 99) {
                throw new Error(`Backup export failed on device (state ${stateCode})`);
            }

            const progressRaw = state801['778'];
            if (typeof progressRaw === 'string' && progressRaw.includes(';')) {
                const parts = progressRaw.split(';').map(Number);
                if (parts.length >= 2 && parts[1] > 0) {
                    const percent = Math.round((parts[0] / parts[1]) * 100);
                    await adapter.setStateAsync('Backup.progress', percent, true);
                }
            }
        }

        if (!done) {
            throw new Error('Backup export timed out');
        }

        adapter.log.info('Backup export finished, downloading file');
        const fileResponse = await axios.get(`${deviceIpAddress}/sec/solarlog_backup.dat`, {
            headers: { Cookie: `banner_hidden=false; SolarLog=${dataToken}` },
            responseType: 'arraybuffer',
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `backup/solarlog_backup_${timestamp}.dat`;
        await adapter.writeFileAsync(adapter.namespace, fileName, Buffer.from(fileResponse.data));

        await adapter.setStateAsync('Backup.status', 'done', true);
        await adapter.setStateAsync('Backup.lastSuccess', new Date().toISOString(), true);
        await adapter.setStateAsync('Backup.lastFile', fileName, true);
        await adapter.setStateAsync('Backup.lastSignature', await getPlantSignature(), true);
        adapter.log.info(`Backup saved as ${fileName} (${fileResponse.data.byteLength} bytes)`);

        await pruneOldBackups();
    } catch (e) {
        adapter.log.warn(`Backup - Error: ${e.message}`);
        await adapter.setStateAsync('Backup.status', 'error', true);
        await adapter.setStateAsync('Backup.lastError', e.message, true);
    } finally {
        backupRunning = false;
    }
} // END runBackup

async function pruneOldBackups() {
    try {
        const files = await adapter.readDirAsync(adapter.namespace, 'backup');
        const backups = files
            .filter(f => f.file.startsWith('solarlog_backup_'))
            .sort((a, b) => (a.file < b.file ? 1 : -1));
        for (const old of backups.slice(backupKeep)) {
            await adapter.unlinkAsync(adapter.namespace, `backup/${old.file}`);
            adapter.log.debug(`Removed old backup ${old.file}`);
        }
    } catch (e) {
        adapter.log.debug(`pruneOldBackups - nothing to prune or error: ${e.message}`);
    }
} // END pruneOldBackups

async function ensureArchiveState(id, name, desc) {
    await adapter.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { name, desc, type: 'number', role: 'value.monthsum', read: true, write: false, unit: 'Wh' },
        native: {},
    });
} // END ensureArchiveState

async function accumulateMonthlyPerDevice() {
    // Solar-Log only reports per-device totals per YEAR (code 854), not per month.
    // We accumulate several things per device ourselves from the daily 'daysum' values:
    //   - yieldmonth: running total for the current month, reset on the 1st
    //   - yieldtotal: a never-resetting lifetime meter reading (Zählerstand)
    //   - solarbezugmonth/netzbezugmonth: today's daysum split into a solar-sourced and
    //     grid-sourced share (see selfConsumptionRatio), accumulated for the month
    // On the 1st, before resetting these, the just-finished month's totals AND the
    // Zählerstand readings at its start/end are archived permanently, so the XLSX report
    // can show Verbrauch = Zählerstand-Ende minus Zählerstand-Anfang as a control figure
    // instead of only the pre-computed delta. This same run also writes ONE row per
    // billable meter to MariaDB (meter_daily) plus one building-wide row
    // (building_daily), if MariaDB is enabled - once/day here, not on every 30s poll.
    try {
        const now = new Date();
        const isFirstOfMonth = now.getDate() === 1;
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        const prodState = await adapter.getStateAsync('status.yieldday');
        const consState = await adapter.getStateAsync('status.consyieldday');
        const yieldWh = prodState && prodState.val !== null ? Number(prodState.val) : 0;
        const consWh = consState && consState.val !== null ? Number(consState.val) : 0;
        const ratio = selfConsumptionRatio(yieldWh, consWh);

        const meterDailyRows = [];
        const dailyTariffs = mariadbPool
            ? await getTariffsForMonth(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'))
            : null;

        for (const name of names) {
            const monthId = `INV.${name}.yieldmonth`;
            const totalId = `INV.${name}.yieldtotal`;
            const dayState = await adapter.getStateAsync(`INV.${name}.daysum`);
            if (!dayState || dayState.val === null || dayState.val === undefined) {
                continue;
            }
            const daysum = Number(dayState.val) || 0;
            const billable = isBillableMeter(name);
            const solarWh = billable ? daysum * ratio : 0;
            const netzWh = billable ? daysum - solarWh : 0;

            const totalState = await adapter.getStateAsync(totalId);
            let zaehlerstandVorher;
            if (totalState && totalState.val !== null && totalState.val !== undefined) {
                zaehlerstandVorher = Number(totalState.val);
            } else {
                // First time this counter is created: seed it with whatever month-to-date
                // consumption is already tracked in yieldmonth, so it starts "caught up"
                // instead of at 0 (which would make Zählerstand-Anfang come out negative
                // for the very first month after this feature was introduced).
                const monthSoFar = await adapter.getStateAsync(monthId);
                zaehlerstandVorher = monthSoFar && monthSoFar.val ? Number(monthSoFar.val) : 0;
            }
            const zaehlerstandNachher = zaehlerstandVorher + daysum;
            await adapter.setStateAsync(totalId, zaehlerstandNachher, true);

            if (billable && mariadbPool && dailyTariffs) {
                meterDailyRows.push(
                    buildMeterDailyRow({
                        date: todayStr,
                        meterName: name,
                        zStartKwh: zaehlerstandVorher / 1000,
                        zEndeKwh: zaehlerstandNachher / 1000,
                        verbrauchKwh: daysum / 1000,
                        solarKwh: solarWh / 1000,
                        netzKwh: netzWh / 1000,
                        tarifNetz: dailyTariffs.netzbezug,
                        tarifSolar: dailyTariffs.solarbezug,
                    }),
                );
            }

            let solarMonthPrevious = 0;
            let netzMonthPrevious = 0;
            if (billable) {
                const solarMonthState = await adapter.getStateAsync(`INV.${name}.solarbezugmonth`);
                const netzMonthState = await adapter.getStateAsync(`INV.${name}.netzbezugmonth`);
                solarMonthPrevious = solarMonthState && solarMonthState.val ? Number(solarMonthState.val) : 0;
                netzMonthPrevious = netzMonthState && netzMonthState.val ? Number(netzMonthState.val) : 0;
            }

            if (isFirstOfMonth) {
                const monthState = await adapter.getStateAsync(monthId);
                if (monthState && monthState.val !== null && monthState.val !== undefined) {
                    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                    const archiveYear = prevMonth.getFullYear();
                    const archiveMonth = String(prevMonth.getMonth() + 1).padStart(2, '0');
                    const base = `Historic.${archiveYear}.monthlyINV.${archiveMonth}.${name}`;

                    await ensureArchiveState(`${base}.monthsum`, 'monthsum', 'Month sum Wh per device/apartment meter');
                    await adapter.setStateAsync(`${base}.monthsum`, monthState.val, true);

                    // Zählerstand at 00:00 on the 1st of that month = the lifetime
                    // counter's value before this run added today's (new month's) daysum.
                    await ensureArchiveState(
                        `${base}.zaehlerstandStart`,
                        'Zählerstand Monatsanfang',
                        'Meter reading at 00:00 on the 1st of the month, Wh',
                    );
                    await adapter.setStateAsync(
                        `${base}.zaehlerstandStart`,
                        zaehlerstandVorher - Number(monthState.val),
                        true,
                    );

                    // Zählerstand at 23:59 on the last day = the counter's value right
                    // before today's (new month's) daysum was added.
                    await ensureArchiveState(
                        `${base}.zaehlerstandEnde`,
                        'Zählerstand Monatsende',
                        'Meter reading at 23:59 on the last day of the month, Wh',
                    );
                    await adapter.setStateAsync(`${base}.zaehlerstandEnde`, zaehlerstandVorher, true);

                    if (billable) {
                        await ensureArchiveState(
                            `${base}.solarbezug`,
                            'Solarbezug',
                            'Consumption sourced from own PV production, proportional building-wide allocation, Wh',
                        );
                        await adapter.setStateAsync(`${base}.solarbezug`, solarMonthPrevious, true);

                        await ensureArchiveState(
                            `${base}.netzbezug`,
                            'Netzbezug',
                            'Consumption sourced from the grid (Verbrauch minus Solarbezug), Wh',
                        );
                        await adapter.setStateAsync(`${base}.netzbezug`, netzMonthPrevious, true);
                    }
                }
                await adapter.setStateAsync(monthId, daysum, true);
                if (billable) {
                    await ensureBillingSplitStates(name);
                    await adapter.setStateAsync(`INV.${name}.solarbezugmonth`, solarWh, true);
                    await adapter.setStateAsync(`INV.${name}.netzbezugmonth`, netzWh, true);
                }
            } else {
                const monthState = await adapter.getStateAsync(monthId);
                const previous = monthState && monthState.val ? Number(monthState.val) : 0;
                await adapter.setStateAsync(monthId, previous + daysum, true);
                if (billable) {
                    await ensureBillingSplitStates(name);
                    await adapter.setStateAsync(`INV.${name}.solarbezugmonth`, solarMonthPrevious + solarWh, true);
                    await adapter.setStateAsync(`INV.${name}.netzbezugmonth`, netzMonthPrevious + netzWh, true);
                }
            }
        }
        adapter.log.debug(
            `Accumulated per-device monthly totals (self-consumption ratio today: ${(ratio * 100).toFixed(1)}%)`,
        );

        if (mariadbPool) {
            try {
                await upsertMeterDaily(mariadbPool, meterDailyRows);
                const buildingRow = buildBuildingDailyRow({
                    date: todayStr,
                    produktionKwh: yieldWh / 1000,
                    verbrauchKwh: consWh / 1000,
                    einspeisungKwh: Math.max(0, yieldWh - consWh) / 1000,
                });
                await upsertBuildingDaily(mariadbPool, buildingRow);
                adapter.log.info(
                    `MariaDB: wrote ${meterDailyRows.length} meter_daily row(s) + 1 building_daily row for ${todayStr}`,
                );
                await regenerateCurrentReport();
            } catch (e) {
                // ioBroker states above are already updated regardless - a DB hiccup only
                // delays persistence/reporting, it never blocks the live/monthly states.
                adapter.log.warn(`MariaDB write failed for ${todayStr} (non-fatal): ${e.message}`);
            }
        }
    } catch (e) {
        adapter.log.warn(`accumulateMonthlyPerDevice - Error: ${e.message}`);
    }
} // END accumulateMonthlyPerDevice

async function ensureBillingSplitStates(name) {
    await adapter.setObjectNotExistsAsync(`INV.${name}.solarbezugmonth`, {
        type: 'state',
        common: {
            name: 'Solarbezug (Monat)',
            desc: 'Running month-to-date consumption sourced from own PV production, Wh',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            unit: 'Wh',
        },
        native: {},
    });
    await adapter.setObjectNotExistsAsync(`INV.${name}.netzbezugmonth`, {
        type: 'state',
        common: {
            name: 'Netzbezug (Monat)',
            desc: 'Running month-to-date consumption sourced from the grid, Wh',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            unit: 'Wh',
        },
        native: {},
    });
} // END ensureBillingSplitStates

/**
 * Connects to MariaDB and ensures the billing schema exists, if enabled in the instance
 * configuration. Never throws - on failure, mariadbPool stays null and every dependent
 * feature (daily DB writes, XLSX reports, scheduled emails) logs a warning and no-ops
 * instead of crashing the adapter. The connection is retried on the next adapter restart.
 */
async function ensureMariaDbPool() {
    if (!adapter.config.mariadbEnabled) {
        adapter.log.debug('MariaDB is disabled in the instance configuration - billing DB features are inactive.');
        return;
    }
    try {
        mariadbPool = mariadb.createPool({
            host: adapter.config.mariadbHost,
            port: Number(adapter.config.mariadbPort) || 3306,
            user: adapter.config.mariadbUser,
            password: adapter.config.mariadbPassword,
            database: adapter.config.mariadbDatabase,
            connectionLimit: 3,
        });
        await ensureSchema(mariadbPool);
        adapter.log.info(
            'MariaDB connected, billing schema ensured (meter_daily/building_daily/meter_yearly_historic).',
        );
    } catch (e) {
        adapter.log.error(`MariaDB setup failed - billing DB writes/reports disabled until next restart: ${e.message}`);
        mariadbPool = null;
    }
} // END ensureMariaDbPool

async function ensureFeedinDayObject() {
    // Declared in io-package.json instanceObjects too, but js-controller does not
    // reliably re-sync instanceObjects common properties (incl. the influxdb.0 custom
    // block) into an already-running instance on a plain file update - only on a real
    // recognized version upgrade. Creating it explicitly here guarantees it exists with
    // InfluxDB logging enabled regardless of how the new code was deployed.
    await adapter.setObjectNotExistsAsync('status.feedinday', {
        type: 'state',
        common: {
            name: 'Feed in grid today',
            type: 'number',
            role: 'value.feedday',
            read: true,
            write: false,
            desc: 'Total energy fed into the grid today, Wh - derived as max(0, yieldday - consyieldday), live-updating throughout the day.',
            unit: 'Wh',
            custom: {
                'influxdb.0': {
                    enabled: true,
                    changesOnly: false,
                    debounceTime: 0,
                    storageType: 'Number',
                    retention: 157680000,
                },
            },
        },
        native: {},
    });
} // END ensureFeedinDayObject

async function ensureDailySplitStates(name) {
    await adapter.setObjectNotExistsAsync(`INV.${name}.solarbezugday`, {
        type: 'state',
        common: {
            name: 'Solarbezug (heute)',
            desc: 'Live, continuously-updating consumption sourced from own PV production today, Wh - for monitoring only, see accumulateMonthlyPerDevice() for the authoritative billed figure',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            unit: 'Wh',
        },
        native: {},
    });
    await adapter.setObjectNotExistsAsync(`INV.${name}.netzbezugday`, {
        type: 'state',
        common: {
            name: 'Netzbezug (heute)',
            desc: 'Live, continuously-updating consumption sourced from the grid today, Wh - for monitoring only, see accumulateMonthlyPerDevice() for the authoritative billed figure',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            unit: 'Wh',
        },
        native: {},
    });
} // END ensureDailySplitStates

// Only actual apartment/common-area consumption meters are billed - WR* are inverters
// (production, not consumption) and 'Gesamt' is a system-wide total that would double
// count against the individual apartment rows.
function isBillableMeter(name) {
    return /^WHG \d+$/.test(name) || name === 'Allgemein';
}

// Netzbezug (grid) and Solarbezug (own PV, sold to tenants below the grid price) are
// billed at different rates - two separate, independently editable tariffs per month.
// Defaults below are illustrative placeholders for Trimmis/Graubünden as of 2026 (typical
// Swiss household grid tariff ~0.28 CHF/kWh incl. grid fees/taxes; a ZEV self-consumption
// price is commonly set below that to stay attractive to tenants, ~0.20 CHF/kWh here) -
// the Treuhänder/landlord MUST verify and correct these against the actual contracted
// rates before relying on them for real billing.
const DEFAULT_TARIFF_NETZBEZUG = 0.28;
const DEFAULT_TARIFF_SOLARBEZUG = 0.2;

async function ensureMonthlyTariffState(year, month) {
    await adapter.setObjectNotExistsAsync(`Tarif.${year}.${month}.netzbezug`, {
        type: 'state',
        common: {
            name: `Netzbezugspreis ${month}/${year}`,
            type: 'number',
            role: 'value',
            read: true,
            write: true,
            def: DEFAULT_TARIFF_NETZBEZUG,
            unit: 'CHF/kWh',
            desc: `Grid tariff for ${month}/${year} (EXAMPLE default, verify actual rate), falls back to Tarif.default.netzbezug when unset`,
        },
        native: {},
    });
    await adapter.setObjectNotExistsAsync(`Tarif.${year}.${month}.solarbezug`, {
        type: 'state',
        common: {
            name: `Solarbezugspreis ${month}/${year}`,
            type: 'number',
            role: 'value',
            read: true,
            write: true,
            def: DEFAULT_TARIFF_SOLARBEZUG,
            unit: 'CHF/kWh',
            desc: `Self-consumption (PV) tariff for ${month}/${year} (EXAMPLE default, verify actual rate), falls back to Tarif.default.solarbezug when unset`,
        },
        native: {},
    });
} // END ensureMonthlyTariffState

async function ensureAllMonthlyTariffsUntil(untilYear) {
    // Pre-create every month from the current one through December of untilYear, so
    // the landlord can plan/fill in tariffs years ahead rather than only ever seeing
    // the current month.
    const now = new Date();
    const startYear = now.getFullYear();
    const startMonth = now.getMonth() + 1;

    for (let year = startYear; year <= untilYear; year++) {
        const fromMonth = year === startYear ? startMonth : 1;
        for (let m = fromMonth; m <= 12; m++) {
            await ensureMonthlyTariffState(year, String(m).padStart(2, '0'));
        }
    }
} // END ensureAllMonthlyTariffsUntil

async function getTariffsForMonth(year, month) {
    // Per-month Netzbezug/Solarbezug tariffs, editable by the landlord in the object tree
    // (pre-created for years ahead at adapter startup, see ensureAllMonthlyTariffsUntil).
    // Each falls back to its own Tarif.default.* only if that specific month was never
    // filled in.
    await ensureMonthlyTariffState(year, month);

    async function resolve(kind, fallbackDefault) {
        const monthState = await adapter.getStateAsync(`Tarif.${year}.${month}.${kind}`);
        if (monthState && monthState.val !== null && monthState.val !== undefined && monthState.val !== '') {
            return Number(monthState.val);
        }
        const defaultState = await adapter.getStateAsync(`Tarif.default.${kind}`);
        if (defaultState && defaultState.val !== null && defaultState.val !== undefined && defaultState.val !== '') {
            return Number(defaultState.val);
        }
        return fallbackDefault;
    }

    return {
        netzbezug: await resolve('netzbezug', DEFAULT_TARIFF_NETZBEZUG),
        solarbezug: await resolve('solarbezug', DEFAULT_TARIFF_SOLARBEZUG),
    };
} // END getTariffsForMonth

/**
 * Regenerates the "current period so far" XLSX report from MariaDB (month-to-date) and
 * makes it available for manual download via Export.lastFile - runs both nightly (after
 * the day's MariaDB write) and on-demand (Export.triggerMeterReadings).
 */
async function regenerateCurrentReport() {
    if (!mariadbPool) {
        adapter.log.warn('Cannot generate report: MariaDB is not enabled/connected (see instance configuration).');
        return;
    }
    try {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const fromDate = `${y}-${m}-01`;
        const toDate = `${y}-${m}-${String(now.getDate()).padStart(2, '0')}`;

        const meterRows = await queryMeterPeriod(mariadbPool, fromDate, toDate);
        const buildingRows = await queryBuildingPeriod(mariadbPool, fromDate, toDate);
        const buffer = await buildReportWorkbook(meterRows, buildingRows, {
            title: `Abrechnung ${fromDate} bis ${toDate} (laufender Monat)`,
        });

        const fileName = `export/${buildReportFileName('manuell', `${y}-${m}`)}`;
        await adapter.writeFileAsync(adapter.namespace, fileName, buffer);
        await adapter.setStateAsync('Export.lastFile', fileName, true);
        adapter.log.info(`Regenerated current-period report: ${fileName} (${meterRows.length} meter rows)`);
    } catch (e) {
        adapter.log.warn(`regenerateCurrentReport - Error: ${e.message}`);
    }
} // END regenerateCurrentReport

/**
 * Builds and sends the scheduled monthly/quarterly/yearly report by email, per
 * lib/scheduling.js's decision. The file is written to the adapter's own file storage
 * FIRST, before attempting to send - so a working copy exists under export/sent/ even
 * if the email delivery itself fails (the whole point of this requirement).
 *
 * @param {{fromDate: string, toDate: string, label: string}} period
 */
async function sendScheduledReport(period) {
    if (!mariadbPool) {
        adapter.log.warn(`Scheduled report for ${period.label} is due but MariaDB is not connected - skipping.`);
        return;
    }
    try {
        const meterRows = await queryMeterPeriod(mariadbPool, period.fromDate, period.toDate);
        const buildingRows = await queryBuildingPeriod(mariadbPool, period.fromDate, period.toDate);
        const buffer = await buildReportWorkbook(meterRows, buildingRows, {
            title: `Abrechnung ${period.label}`,
        });

        const year = period.fromDate.slice(0, 4);
        const fileName = `export/sent/${year}/${buildReportFileName(adapter.config.reportSchedule, period.label)}`;
        await adapter.writeFileAsync(adapter.namespace, fileName, buffer);
        adapter.log.info(`Scheduled report for ${period.label} saved: ${fileName}`);

        if (adapter.config.reportRecipient) {
            await adapter.sendToAsync('email.0', 'send', {
                to: adapter.config.reportRecipient,
                subject: `Solar-Abrechnung ${period.label}`,
                text: `Im Anhang die Abrechnung für ${period.label} (${period.fromDate} bis ${period.toDate}).`,
                attachments: [
                    {
                        filename: fileName.split('/').pop(),
                        content: buffer.toString('base64'),
                        encoding: 'base64',
                    },
                ],
            });
            adapter.log.info(`Scheduled report for ${period.label} sent to ${adapter.config.reportRecipient}.`);
        } else {
            adapter.log.warn(`Scheduled report for ${period.label} saved but not sent: no recipient configured.`);
        }
    } catch (e) {
        // File (if it got written before the failure) stays in export/sent/ as the fallback.
        adapter.log.error(`sendScheduledReport(${period.label}) - Error: ${e.message}`);
    }
} // END sendScheduledReport

/**
 * Deletes files under export/sent/ older than 365 days - the "1 year archival, then
 * cleaned up" requirement for sent-report fallback copies.
 */
async function cleanupSentReports() {
    try {
        const files = await adapter.readDirAsync(adapter.namespace, 'export/sent');
        const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
        for (const f of files) {
            if (!f.isDir && f.modifiedAt && f.modifiedAt < cutoff) {
                await adapter.unlinkAsync(adapter.namespace, `export/sent/${f.file}`);
                adapter.log.info(`Removed sent-report older than 1 year: ${f.file}`);
            }
        }
    } catch (e) {
        // readDirAsync throws if the folder doesn't exist yet (nothing sent so far) - not an error.
        adapter.log.debug(`cleanupSentReports: ${e.message}`);
    }
} // END cleanupSentReports

/**
 * Runs once/day: decides (via lib/scheduling.js) whether a scheduled report is due
 * today, sends it if so, and prunes sent-report copies older than 1 year regardless.
 */
async function checkAndSendScheduledReport() {
    await cleanupSentReports();
    if (!adapter.config.reportEnabled) {
        return;
    }
    const period = determineScheduledPeriod(
        new Date(),
        adapter.config.reportSchedule,
        Number(adapter.config.reportCutoffDay) || 1,
    );
    if (period) {
        adapter.log.info(`Scheduled report due today: ${period.label} (${period.fromDate} - ${period.toDate})`);
        await sendScheduledReport(period);
    }
} // END checkAndSendScheduledReport

async function test() {
    try {
        const obj = await adapter.getStateAsync('info.numinv');
        if (obj) {
            const numbinv = obj.val;
            adapter.log.debug(`Inverters to test: ${names}`);
            adapter.log.debug(`numbinv: ${numbinv}`);
            names.forEach(check);
            adapter.log.debug(`Counts positive: ${testi}`);
            if (testi == numbinv) {
                clearInterval(testend);
                adapter.log.info('All inverters/counters found');
                adapter.log.debug(`Names: ${names}`);
                await setDeviceInfo(names);
            } else {
                testi = 0;
                adapter.log.warn('Not found all inverters/counters');
                testj++;
                if (testj > 5) {
                    adapter.log.warn('Error, not set all subdevices');
                    clearInterval(testend);
                }
            }
        }
    } catch (e) {
        adapter.log.warn(`Test - Error: ${e.message}`);
    }
} // END test()

function check(uz) {
    try {
        adapter.getObject(`INV.${uz}`, function (err, obj) {
            if (obj) {
                adapter.log.debug(`Adapter ${uz} available`);
                testi++;
            } else {
                adapter.log.warn(`Adapter ${uz} not existing`);
            }
        });
    } catch (e) {
        adapter.log.warn(`check - Error: ${e.message}`);
    }
} // END check()

async function login() {
    try {
        const options = JSON.parse(JSON.stringify(optionsDefault));
        options.headers = {
            Cookie: 'banner_hidden=false',
        };
        adapter.log.debug(`Options: ${JSON.stringify(options)}`);
        adapter.log.debug('starting LOGIN');

        // Solarlog API codes (each account level has its own hash-required flag + salt):
        // '550' is the main request object for login parameters.
        // '103'/'104' = hash-required flag / salt for the 'user' account.
        // '109'/'110' = hash-required flag / salt for the 'installer' account.
        // Each account uses its OWN salt - reusing the 'user' salt for the 'installer'
        // login (or vice versa) produces a wrong hash and a "Password was wrong" response.
        const getjpPayload = { 550: { 103: null, 104: null, 109: null, 110: null } };
        const prot = await axios.post(`${deviceIpAddress}/getjp`, getjpPayload, options);
        const b = prot?.data?.['550'] || {};

        const hashFlagField = loginLevel === 'installer' ? '109' : '103';
        const saltField = loginLevel === 'installer' ? '110' : '104';
        const pw = loginLevel === 'installer' ? installerPw : userPw;

        const pwsHashed = b[hashFlagField] === 1 || b[hashFlagField] === '1' || b[hashFlagField] === true;
        const salt = b[saltField];
        const pwdForPost = pwsHashed && salt ? bcrypt.hashSync(pw, salt) : pw;
        const loginData = `u=${userName}&p=${pwdForPost}`;

        try {
            const response = await axios.post(`${deviceIpAddress}/login`, loginData, options);

            adapter.log.debug(`Status-Code: ${response.status}`);
            adapter.log.debug(`Header: ${JSON.stringify(response.headers)}`);
            adapter.log.debug(`Response.body= ${response.data}`);
            adapter.log.debug(`Cookie: ${response.headers['set-cookie']}`);

            const token = response.headers['set-cookie'].toString();
            dataToken = token.slice(9);
            adapter.log.debug(`Datatoken: ${dataToken}`);
        } catch (error) {
            adapter.log.info(`Login - axios - Error: ${error}`);
            if (requestCounter > 4) {
                adapter.log.warn('repeated login error, requests stopped, adapter is restarted in 90s.');

                unload();

                restartTimer = setTimeout(() => {
                    restartTimer = null;
                    restartAdapter();
                }, 90000);
            } else {
                adapter.log.info(`login error: Code:${error}. login will be retried.`);
                requestCounter++;
            }
        }
    } catch (e) {
        adapter.log.warn(`Login - Error: ${e.message}`);
    }
} //END login

async function logCheck(dataLC) {
    try {
        if (!loginLevel) {
            await httpsRequest(dataLC);
        } else {
            const options = JSON.parse(JSON.stringify(optionsDefault));
            options.headers['Cookie'] = `banner_hidden=false; SolarLog=${dataToken}`;

            adapter.log.debug(`Options: ${JSON.stringify(options)}`);
            adapter.log.debug('starting LogCheck');

            try {
                const response = await axios.get(`${deviceIpAddress}/logcheck?`, options);

                adapter.log.debug(`Status-Code: ${response.status}`);
                adapter.log.debug(`Header: ${JSON.stringify(response.headers)}`);
                adapter.log.debug(`Response.body= ${response.data}`);

                const bodyArray = response.data.split(';');
                adapter.log.debug(`bodyarray0= ${bodyArray[0]}`);

                //logcheck: 0;0;1 = nicht angemeldet, 1;2;2= installateur 1;3;3 =inst/pm 1;1;1 =benutzer
                if (bodyArray[0] != 0) {
                    adapter.log.debug('login OK, starting request');
                    await httpsRequest(dataLC);
                } else {
                    adapter.log.info('login NOT OK, restart login, then request');
                    await login();
                    setTimeout(async () => await logCheck(dataLC), 2000);
                }
            } catch (error) {
                adapter.log.info(`Logcheck - axios - Error: ${error}`);

                if (requestCounter > 4) {
                    adapter.log.warn('repeated Logcheck error, requests stopped, adapter is restarded in 90s.');
                    unload();

                    restartTimer = setTimeout(() => {
                        restartTimer = null;
                        restartAdapter();
                    }, 90000);
                } else {
                    adapter.log.info(
                        `Fehler beim Logcheck: Statuscode:${error}. Führe Logcheck bei nächster Gelegenheit erneut aus.`,
                    );
                    requestCounter++;
                }
            }
        }
    } catch (e) {
        adapter.log.warn(`Logcheck - Error: ${e.message}`);
    }
} //logcheck END

async function httpsRequest(reqData) {
    //Führt eine Abfrage beim solarlog durch und übergibt das REsultat zur Auswertung.
    try {
        let reqAddress = deviceIpAddress;
        let options;
        if (reqData.includes('.json')) {
            //adapter.log.debug('DATA: ' + reqdata + ' and DATALENGTH: ' + reqdata.length)
            options = JSON.parse(JSON.stringify(optionsJson));
            options.headers['Cookie'] = `banner_hidden=true; SolarLog=${dataToken}`;
            //options.pathname = reqdata + Date.now().toString();

            reqAddress = deviceIpAddress + reqData + Date.now().toString();

            options.url = `${reqAddress}`;
            //options.params = {
            //`_`: `${Date.now().toString()}`
            //};
        } else {
            //const data = 'token=' + datatoken + ';preval=none;' + reqdata;

            //adapter.log.debug('DATA: ' + reqdata + ' and DATALENGTH: ' + reqdata.length)
            options = JSON.parse(JSON.stringify(optionsDefault));
            options.headers['Cookie'] = `banner_hidden=false; SolarLog=${dataToken}`;

            options.url = `${reqAddress}${cmd}`;
            options.data = `token=${dataToken};preval=none;${reqData}`;

            //options.pathname = cmd;
            //options.headers['Content-Length'] = data.length;
        }

        adapter.log.debug(` OPTIONS: ${JSON.stringify(options)}`); //ReqAddress: ${reqAddress} ReqData: ${reqData}

        try {
            const response = await axios(
                /*`${reqAddress}${cmd}`, `token=${dataToken};preval=none;${reqData}`, */ options,
            );

            adapter.log.debug(`Status-Code: ${response.status}`);
            adapter.log.debug(`Header: ${JSON.stringify(response.headers)}`);
            adapter.log.debug(`Response.body= ${JSON.stringify(response.data)}`);

            const bodyr = JSON.stringify(response.data);

            requestCounter = 0;
            if (reqData.includes('.json')) {
                await readSolarlogDataJson(reqData, bodyr);
                adapter.log.debug(`END Request: ${reqData}`);
            } else {
                await readSolarlogData(reqData, bodyr);
                adapter.log.debug(`END Request: ${reqData}`);
            }
        } catch (error) {
            adapter.log.info(`httpsRequest - axios - Error: ${error}`);

            if (requestCounter > 4) {
                adapter.log.warn('repeated http-Request console.error, requests stopped, adapter is restarted in 90s.');
                unload();

                restartTimer = setTimeout(() => {
                    restartTimer = null;
                    restartAdapter();
                }, 90000);
            } else {
                adapter.log.info(`http-request error: code:${error}. request will be repeated.`);
                requestCounter++;
            }
        }
    } catch (e) {
        adapter.log.warn(`JSON-parse error httpsRequest: ${e.message}`);
    }
} //end httpsRequest

async function readSolarlogData(reqData, resData) {
    try {
        adapter.log.debug('processing Data');
        adapter.log.debug(`data set: ${reqData}`);
        adapter.log.debug(`evaluation data: ${resData}`);

        switch (reqData.slice(0, 6)) {
            case '{"141"': //inverter names and deviceinfo-code
                try {
                    const dataJuzna = JSON.parse(resData)[141];

                    for (let y = 0; y < numinv - 1; y++) {
                        names.push(dataJuzna[y][119]);
                        adapter.log.debug(`Inverters: ${names}`);
                        deviceinfos.push(dataJuzna[y][162]);
                        adapter.log.debug(`Deviceinfos: ${deviceinfos}`);
                    }

                    await defDeviceInfo();
                } catch (e) {
                    adapter.log.warn(`JSON-parse error, inverter names/deviceinfo: ${e.message}`);
                    throw e;
                }

                break;

            case '{"152"': //const startupData = ''{"152":null,"161":null,"162":null,"447":null,"610":null,"611":null,"617":null,"706":null,"739":null,"740":null,"744":null,"800":{"100":null,"160":null},"801":{"101":null,"102":null},"858":null,"895":{"100":null,"101":null,"102":null,"103":null,"104":null,"105":null}}';
                try {
                    //"739":null,"744":null
                    deviceList = JSON.parse(resData)[739];
                    adapter.log.debug(`Devicelist: ${deviceList}`);
                    brandlist = JSON.parse(resData)[744];
                    adapter.log.debug(`Brandlist: ${JSON.stringify(brandlist)}`);
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - Fehler in get devicelist/brandlist: ${e}`);
                    throw e;
                }

                try {
                    //"740":null
                    const dataJ = JSON.parse(resData)[740];
                    adapter.log.debug(`List of Inverters: ${JSON.stringify(dataJ)}`);
                    while (statusuz !== 'Err' && numinv < 100) {
                        statusuz = dataJ[numinv.toString()];
                        numinv++;
                    }
                    await adapter.setStateAsync('info.numinv' /*numinv*/, numinv - 1, true);
                    adapter.log.debug(`Number of inverters/meters :${numinv - 1}`);

                    for (var i = 0; i < numinv - 1; i++) {
                        var dataFront = '{"141":{';
                        var dataElements = '":{"119":null,"162":null}';
                        inverterDataArray.push(`"${i.toString()}${dataElements}`);
                    }

                    const inverterData = `${dataFront + inverterDataArray.toString()}}}`;

                    await logCheck(inverterData);
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in get numinv: ${e}`);
                    throw e;
                }

                try {
                    //"447":null
                    const sgdata = JSON.parse(resData)[447];
                    adapter.log.debug(`Schaltgruppendaten: ${JSON.stringify(sgdata)}`);
                    for (let isg = 0; isg < 10; isg++) {
                        const sgname = JSON.parse(resData)[447][isg][100];
                        sgname && adapter.log.debug(`neue Schaltgruppe: ${sgname}`);
                        namessg[isg] = sgname.replace(/\s+/g, '');
                    }
                    adapter.log.debug(`number of switchgroups: ${namessg.filter(Boolean).length}`);
                    numsg = namessg.filter(Boolean).length;
                    adapter.log.debug(`namessg = ${namessg}`);
                    adapter.log.debug(`swichgroups new: ${namessg}`);
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in get switchgrouplist: ${e}`);
                    throw e;
                }

                try {
                    //"610":null,"611":null,"617":null,"706":null,"800":{"100":null,"160":null},"801":{"101":null,"102":null},"858":null,"895":{"100":null,"101":null,"102":null,"103":null,"104":null,"105":null}
                    await adapter.setStateAsync('info.RTOS', JSON.parse(resData)[610], true);
                    await adapter.setStateAsync('info.CLIB', JSON.parse(resData)[611], true);
                    await adapter.setStateAsync('info.MAC', JSON.parse(resData)[617], true);
                    await adapter.setStateAsync('info.SN', JSON.parse(resData)[706], true);
                    await adapter.setStateAsync('info.Model', JSON.parse(resData)[800][100].toString(), true);
                    await adapter.setStateAsync('info.InstDate', JSON.parse(resData)[800][160], true);
                    await adapter.setStateAsync('info.FW', JSON.parse(resData)[801][101], true);
                    await adapter.setStateAsync('info.FWrelD', JSON.parse(resData)[801][102], true);
                    const sdinfo = JSON.parse(resData)[895];
                    await adapter.setStateAsync(
                        'info.SD',
                        `[${sdinfo[101]}|${sdinfo[103]}|${sdinfo[102]}|${sdinfo[100]}] - ${sdinfo[104]}/${sdinfo[105]}`,
                        true,
                    );
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in system information: ${e}`);
                    throw e;
                }

                try {
                    //"152":null,"161":null,"162":null
                    const effizienz = JSON.parse(resData)[162];
                    const leistung = JSON.parse(resData)[161];
                    const setPointY = effizienz * (leistung / 1000);

                    await adapter.setStateAsync('forecast.setpointYear', setPointY, true);
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.01',
                        (JSON.parse(resData)[152][0] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.02',
                        (JSON.parse(resData)[152][1] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.03',
                        (JSON.parse(resData)[152][2] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.04',
                        (JSON.parse(resData)[152][3] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.05',
                        (JSON.parse(resData)[152][4] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.06',
                        (JSON.parse(resData)[152][5] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.07',
                        (JSON.parse(resData)[152][6] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.08',
                        (JSON.parse(resData)[152][7] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.09',
                        (JSON.parse(resData)[152][8] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.10',
                        (JSON.parse(resData)[152][9] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.11',
                        (JSON.parse(resData)[152][10] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointMonth.12',
                        (JSON.parse(resData)[152][11] / 100) * setPointY,
                        true,
                    );

                    const ds = new Date();
                    const m = ds.getMonth();
                    await adapter.setStateAsync(
                        'forecast.setpointCurrMonth',
                        (JSON.parse(resData)[152][m] / 100) * setPointY,
                        true,
                    );
                    await adapter.setStateAsync(
                        'forecast.setpointToday',
                        ((JSON.parse(resData)[152][m] / 100) * setPointY) / 30,
                        true,
                    );
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in setpoint: ${e}`);
                    throw e;
                }

                try {
                    //"858":null
                    battdata = JSON.parse(resData)[858];
                    adapter.log.debug(`Battdata: ${battdata}`);
                    if (battdata.length > 0) {
                        battPresent = true;
                        adapter.log.debug('Battery available, lege Objekte an.');
                        adapter.log.debug(`status battery: ${battPresent}`);
                    } else {
                        adapter.log.debug('no battery available.');
                        adapter.log.debug(`Status battery: ${battPresent}`);
                    }

                    adapter.log.debug('END');
                } catch (e) {
                    adapter.log.warn(`JSON-parse error Battpresent: ${e.message}`);
                    throw e;
                }

                if (names.length > 0 && deviceclasses.length > 0) {
                    await setInvObjects();
                }
                break;

            case '{"447"': //pollingData = '{"447":null,"777":{"0":null},"778":{"0":null},"801":{"170":null}}';
                try {
                    //"447":null
                    const dataSG = JSON.parse(resData)[447];
                    adapter.log.debug(`switchgroups: ${namessg}`);
                    adapter.log.debug(`Nuber of elements: ${numsg}`);
                    for (let sgj = 0; sgj < 10; sgj++) {
                        if (namessg[sgj]) {
                            adapter.log.debug(`SwichtGroup.${namessg[sgj]} Modus: ${dataSG[sgj][102]}`);
                            await adapter.setStateAsync(`SwitchGroup.${namessg[sgj]}.mode`, dataSG[sgj][102], true);
                            adapter.log.debug(
                                `SwichtGroup.${namessg[sgj]} linked hardware: ${names[dataSG[sgj][101][0][100]]}`,
                            );
                            await adapter.setStateAsync(
                                `SwitchGroup.${namessg[sgj]}.linkeddev`,
                                names[dataSG[sgj][101][0][100]],
                                true,
                            );
                            adapter.log.debug(
                                `SwichtGroup.${namessg[sgj]} linked hardware subunit: ${dataSG[sgj][101][0][101]}`,
                            );
                            await adapter.setStateAsync(
                                `SwitchGroup.${namessg[sgj]}.linkeddevsub`,
                                dataSG[sgj][101][0][101],
                                true,
                            );
                        }
                    }
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in swichtgroupmode: ${e}`);
                    throw e;
                }

                try {
                    //"801":{"170":null}
                    json = JSON.parse(resData)[801][170];
                    adapter.log.debug(`Data801_170: ${JSON.stringify(json)}`);
                    await adapter.setStateAsync('info.lastSync', json[100].toString(), true);
                    await adapter.setStateAsync('info.totalPower', parseInt(json[116]), true);
                    await adapter.setStateAsync('status.pac', parseInt(json[101]), true);
                    await adapter.setStateAsync('status.pdc', parseInt(json[102]), true);
                    await adapter.setStateAsync('status.uac', parseInt(json[103]), true);
                    await adapter.setStateAsync('status.udc', parseInt(json[104]), true);
                    await adapter.setStateAsync('status.conspac', parseInt(json[110]), true);
                    await adapter.setStateAsync('status.yieldday', parseInt(json[105]), true);
                    await adapter.setStateAsync('status.yieldyesterday', parseInt(json[106]), true);
                    await adapter.setStateAsync('status.yieldmonth', parseInt(json[107]), true);
                    await adapter.setStateAsync('status.yieldyear', parseInt(json[108]), true);
                    await adapter.setStateAsync('status.yieldtotal', parseInt(json[109]), true);
                    await adapter.setStateAsync('status.consyieldday', parseInt(json[111]), true);
                    await adapter.setStateAsync('status.consyieldyesterday', parseInt(json[112]), true);
                    await adapter.setStateAsync('status.consyieldmonth', parseInt(json[113]), true);
                    await adapter.setStateAsync('status.consyieldyear', parseInt(json[114]), true);
                    await adapter.setStateAsync('status.consyieldtotal', parseInt(json[115]), true);
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in standard data request: ${e}`);
                    throw e;
                }

                try {
                    //"777":{"0":null}
                    const dataSUZ = JSON.parse(resData)[777][0];
                    adapter.log.debug(`DataSUZ: ${dataSUZ}`);
                    adapter.log.debug(`Inv. to treat: ${names}`);
                    const namLeng = names.length;
                    adapter.log.debug(`Number of elements: ${namLeng}`);
                    const d = new Date();
                    const heute = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear() - 2000}`;
                    adapter.log.debug(`today: ${heute}`);
                    for (let isuz = 0; isuz < 31; isuz++) {
                        if (dataSUZ[isuz].includes(heute.toString())) {
                            var indexsuz = isuz;
                            adapter.log.debug(`Index daily values: ${indexsuz}`);
                            break;
                        }
                    }
                    const daysum = dataSUZ[indexsuz][1];
                    adapter.log.debug(`daysums: ${daysum}`);
                    // Live, continuously-updating solar/grid split for TODAY per billable meter,
                    // using the SAME building-wide production/consumption values from this exact
                    // poll response (json[105]/json[111]) - so it's always in sync with the daysum
                    // just written above, not a stale value from a separate poll cycle. This is
                    // for live monitoring only; the authoritative billed figures are the once-nightly
                    // accumulateMonthlyPerDevice() snapshot (see there for why: daysum can still tick
                    // up until midnight).
                    const yieldDayWh = parseInt(json[105]) || 0;
                    const consDayWh = parseInt(json[111]) || 0;
                    const dayRatio = selfConsumptionRatio(yieldDayWh, consDayWh);
                    // Complementary quantity to dayRatio: whatever wasn't self-consumed (capped at
                    // what was actually produced) was fed into the grid. Building-wide, not per-meter -
                    // there's only one grid connection point, feed-in isn't attributable to one meter.
                    await adapter.setStateAsync('status.feedinday', Math.max(0, yieldDayWh - consDayWh), true);
                    for (let suzi = 0; suzi < namLeng; suzi++) {
                        if (deviceclasses[suzi] !== 'Batterie') {
                            adapter.log.debug(`INV.${names[suzi]}: ${daysum[suzi]}`);
                            await adapter.setStateAsync(`INV.${names[suzi]}.daysum`, daysum[suzi], true);

                            if (isBillableMeter(names[suzi])) {
                                await ensureDailySplitStates(names[suzi]);
                                const meterDaysum = Number(daysum[suzi]) || 0;
                                const solarToday = meterDaysum * dayRatio;
                                await adapter.setStateAsync(`INV.${names[suzi]}.solarbezugday`, solarToday, true);
                                await adapter.setStateAsync(
                                    `INV.${names[suzi]}.netzbezugday`,
                                    meterDaysum - solarToday,
                                    true,
                                );
                            }
                        }
                    }
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in sum data inverters: ${e}`);
                    throw e;
                }

                try {
                    ////"778":{"0":null}
                    const dataselfcons = JSON.parse(resData)[778][0];
                    adapter.log.debug(`DataSelfCons: ${dataselfcons}`);
                    const d = new Date();
                    const heute = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear() - 2000}`;
                    adapter.log.debug(`today: ${heute}`);
                    const monatheute = d.getMonth() + 1;
                    adapter.log.debug(`month today: ${monatheute}`);
                    for (let isuz = 0; isuz < 31; isuz++) {
                        if (dataselfcons[isuz].includes(heute.toString())) {
                            /*var*/ indexsuz = isuz;
                            adapter.log.debug(`Index daily values: ${indexsuz}`);
                            break;
                        }
                    }
                    const dataselfconstoday = dataselfcons[indexsuz];
                    adapter.log.debug(`daily values SelfCons: ${dataselfconstoday}`);
                    const daysum = dataselfcons[indexsuz][1];
                    adapter.log.debug(`daysum self consumption: ${daysum}`);
                    const dayratio = Math.round((daysum / json[105]) * 1000) / 10;

                    await adapter.setStateAsync('SelfCons.selfconstoday', daysum, true);
                    await adapter.setStateAsync('SelfCons.selfconsratiotoday', dayratio, true);

                    d.setDate(d.getDate() - 1);
                    const gestern = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear() - 2000}`;
                    adapter.log.debug(`yesterday: ${gestern}`);
                    const monatGestern = d.getMonth() + 1;
                    adapter.log.debug(`month yesterday: ${monatGestern}`);
                    if (monatGestern === monatheute) {
                        for (let iscy = 0; iscy < 31; iscy++) {
                            if (dataselfcons[iscy].includes(gestern.toString())) {
                                var indexscy = iscy;
                                adapter.log.debug(`Index daily values yesterday: ${indexscy}`);
                                break;
                            }
                        }
                        const dataselfconsyesterday = dataselfcons[indexscy];
                        adapter.log.debug(`yesterday-values SelfCons: ${dataselfconsyesterday}`);
                        const daysumy = dataselfcons[indexscy][1];
                        adapter.log.debug(`yesterday-sum self consumption: ${daysumy}`);
                        const dayratioy = Math.round((daysumy / json[106]) * 1000) / 10;

                        await adapter.setStateAsync('SelfCons.selfconsyesterday', daysumy, true);
                        await adapter.setStateAsync('SelfCons.selfconsratioyesterday', dayratioy, true);
                        lastdaysumy = daysum;
                        lastdayratioy = dayratio;
                    } else {
                        await adapter.setStateAsync('SelfCons.selfconsyesterday', lastdaysumy, true);
                        await adapter.setStateAsync('SelfCons.selfconsratioyesterday', lastdayratioy, true);
                    }

                    if (battDevicePresent && battPresent) {
                        await adapter.setStateAsync(
                            `INV.${names[battindex[0]]}.BattSelfCons`,
                            dataselfconstoday[2],
                            true,
                        );
                        await adapter.setStateAsync(
                            `INV.${names[battindex[0]]}.BattChargeDaysum`,
                            dataselfconstoday[3],
                            true,
                        );
                        await adapter.setStateAsync(
                            `INV.${names[battindex[0]]}.BattDischargeDaysum`,
                            dataselfconstoday[4],
                            true,
                        );
                    } else if (!battDevicePresent && battPresent) {
                        await adapter.setStateAsync('INV.Battery.BattSelfCons', dataselfconstoday[2], true);
                        await adapter.setStateAsync('INV.Battery.BattChargeDaysum', dataselfconstoday[3], true);
                        await adapter.setStateAsync('INV.Battery.BattDischargeDaysum', dataselfconstoday[4], true);
                    } else if (!battDevicePresent && !battPresent) {
                        adapter.log.debug('no batery available');
                    } else {
                        adapter.log.debug('Strange: battery data available but no battery index data');
                    }
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in self consumption: ${e}`);
                    throw e;
                }

                break;

            case '{"608"': //fastpollData = '{"608":null,"780":null,"781":null,"782":null,"801":{"175":null},"858":null}';
                try {
                    //"608":null
                    const datafast = JSON.parse(resData);

                    if (datafast[608][0].includes('DENIED') == true) {
                        adapter.log.warn('SolarLog access violation - restart Adapter');
                        restartAdapter();
                    } else {
                        adapter.log.debug(`Inv. to treat: ${names}`);
                        const namLeng = names.length;
                        adapter.log.debug(`number of elements: ${namLeng}`);
                        for (let uzj = 0; uzj < namLeng; uzj++) {
                            if (deviceclasses[uzj] !== 'Batterie') {
                                adapter.log.debug(`INV.${names[uzj]} Status: ${datafast[608][uzj]}`);
                                await adapter.setStateAsync(`INV.${names[uzj]}.status`, datafast[608][uzj], true);
                                adapter.log.debug(`INV.${names[uzj]} PAC: ${datafast[782][uzj]}`);
                                await adapter.setStateAsync(
                                    `INV.${names[uzj]}.PAC`,
                                    parseInt(datafast[782][uzj]),
                                    true,
                                );
                            }
                        }

                        adapter.log.debug(`switchgroups: ${namessg}`);

                        adapter.log.debug(`number of switchgroups: ${numsg}`);
                        for (let sgsj = 0; sgsj < 10; sgsj++) {
                            if (namessg[sgsj]) {
                                adapter.log.debug(
                                    `SwichtGroup.${namessg[sgsj]} Status: ${datafast[801][175][sgsj][101]}`,
                                );
                                await adapter.setStateAsync(
                                    `SwitchGroup.${namessg[sgsj]}.state`,
                                    datafast[801][175][sgsj][101],
                                    true,
                                );
                            }
                        }

                        battdata = datafast[858];
                        adapter.log.debug(`Battdata: ${battdata}`);
                        adapter.log.debug(`Battdata - length: ${battdata.length}`);
                        if (!battdata.length) {
                            battdata[2] = 0;
                            battdata[3] = 0;
                        }
                        adapter.log.debug(`production: ${+datafast[780] - +battdata[3]}`);
                        await adapter.setStateAsync('status.pac', parseInt(+datafast[780] - +battdata[3]), true);
                        adapter.log.debug(`consumption: ${+datafast[781] - +battdata[2]}`);
                        await adapter.setStateAsync('status.conspac', parseInt(+datafast[781] - +battdata[2]), true);

                        if (battDevicePresent && battPresent) {
                            await adapter.setStateAsync(`INV.${names[battindex[0]]}.BattLevel`, battdata[1], true);
                            await adapter.setStateAsync(`INV.${names[battindex[0]]}.ChargePower`, battdata[2], true);
                            await adapter.setStateAsync(`INV.${names[battindex[0]]}.DischargePower`, battdata[3], true);
                            feed = +datafast[780] - +datafast[781];
                            adapter.log.debug(`production(+)/consumption(-): ${feed}`);
                            await adapter.setStateAsync('status.feed', feed, true);
                            if (Math.sign(feed) === 1) {
                                await adapter.setStateAsync('status.feedin', feed, true);
                                await adapter.setStateAsync('status.feedinactive', true, true);
                                await adapter.setStateAsync('status.feedout', 0, true);
                            } else {
                                await adapter.setStateAsync('status.feedin', 0, true);
                                await adapter.setStateAsync('status.feedinactive', false, true);
                                await adapter.setStateAsync('status.feedout', Math.abs(feed), true);
                            }
                        } else if (!battDevicePresent && battPresent) {
                            await adapter.setStateAsync('INV.Battery.BattLevel', battdata[1], true);
                            await adapter.setStateAsync('INV.Battery.ChargePower', battdata[2], true);
                            await adapter.setStateAsync('INV.Battery.DischargePower', battdata[3], true);
                            feed = +datafast[780] - +datafast[781];
                            adapter.log.debug(`production(+)/consumption(-): ${feed}`);
                            await adapter.setStateAsync('status.feed', feed, true);
                            if (Math.sign(feed) === 1) {
                                await adapter.setStateAsync('status.feedin', feed, true);
                                await adapter.setStateAsync('status.feedinactive', true, true);
                                await adapter.setStateAsync('status.feedout', 0, true);
                            } else {
                                await adapter.setStateAsync('status.feedin', 0, true);
                                await adapter.setStateAsync('status.feedinactive', false, true);
                                await adapter.setStateAsync('status.feedout', Math.abs(feed), true);
                            }
                        } else if (!battDevicePresent && !battPresent) {
                            adapter.log.debug('no battery available');
                            feed = +datafast[780] - +datafast[781];
                            adapter.log.debug(`production(+)/consumption(-): ${feed}`);
                            await adapter.setStateAsync('status.feed', feed, true);
                            if (Math.sign(feed) === 1) {
                                await adapter.setStateAsync('status.feedin', feed, true);
                                await adapter.setStateAsync('status.feedinactive', true, true);
                                await adapter.setStateAsync('status.feedout', 0, true);
                            } else {
                                await adapter.setStateAsync('status.feedin', 0, true);
                                await adapter.setStateAsync('status.feedinactive', false, true);
                                await adapter.setStateAsync('status.feedout', Math.abs(feed), true);
                            }
                        } else {
                            adapter.log.debug('Strange: battery-data available, but battery indicators wrong');
                        }

                        setDisplayData(datafast[794][0]);
                    }
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in datafast: ${e}`);
                    throw e;
                }
                break;

            case `{"854"`: //const historicData = '{"854":null,"877":null,"878":null}';
                try {
                    //"854":null
                    const dataYear = JSON.parse(resData)[854];
                    adapter.log.debug(`DataYear: ${dataYear}`);
                    adapter.log.debug(`Inv. to treat: ${names}`);
                    const namLeng = names.length;

                    adapter.log.debug(`number of elements: ${namLeng}`);
                    for (let iy = 0; iy < dataYear.length; iy++) {
                        const year = dataYear[iy][0].slice(-2);
                        for (let inu = 0; inu < names.length; inu++) {
                            if (dataYear[iy][1][inu]) {
                                await adapter.setObjectNotExistsAsync(`Historic.20${year}.yieldyearINV.${names[inu]}`, {
                                    type: 'state',
                                    common: {
                                        name: 'yieldyear',
                                        desc: 'Year sum Wh',
                                        type: 'number',
                                        role: 'value.yearsum',
                                        read: true,
                                        write: false,
                                        unit: 'Wh',
                                    },
                                    native: {},
                                });
                            }
                        }
                    }

                    for (let iy = 0; iy < dataYear.length; iy++) {
                        const year = dataYear[iy][0].slice(-2);
                        for (let inu = 0; inu < names.length; inu++) {
                            if (dataYear[iy][1][inu]) {
                                await adapter.setStateAsync(
                                    `Historic.20${year}.yieldyearINV.${names[inu]}`,
                                    dataYear[iy][1][inu],
                                    true,
                                );
                            }
                        }
                    }
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in status data inverters: ${e}`);
                    throw e;
                }

                if (reqData.includes('"877"')) {
                    try {
                        //"877":null
                        const dataMonthtot = JSON.parse(resData)[877];
                        adapter.log.debug(`DataMonth: ${dataMonthtot}`);

                        for (let iy = 0; iy < dataMonthtot.length; iy++) {
                            const year = dataMonthtot[iy][0].slice(-2);
                            const month = dataMonthtot[iy][0].slice(3, 5);

                            await adapter.setObjectNotExistsAsync(`Historic.20${year}.monthly.${month}.yieldmonth`, {
                                type: 'state',
                                common: {
                                    name: 'yieldmonth',
                                    desc: 'Month sum production Wh',
                                    type: 'number',
                                    role: 'value.monthsum',
                                    read: true,
                                    write: false,
                                    unit: 'Wh',
                                },
                                native: {},
                            });

                            await adapter.setObjectNotExistsAsync(`Historic.20${year}.monthly.${month}.consmonth`, {
                                type: 'state',
                                common: {
                                    name: 'consmonth',
                                    desc: 'Month sum consumption Wh',
                                    type: 'number',
                                    role: 'value.monthsum',
                                    read: true,
                                    write: false,
                                    unit: 'Wh',
                                },
                                native: {},
                            });

                            await adapter.setObjectNotExistsAsync(`Historic.20${year}.monthly.${month}.selfconsmonth`, {
                                type: 'state',
                                common: {
                                    name: 'selfconsmonth',
                                    desc: 'Month sum  self consumption Wh',
                                    type: 'number',
                                    role: 'value.monthsum',
                                    read: true,
                                    write: false,
                                    unit: 'kWh',
                                },
                                native: {},
                            });
                        }

                        for (let iy = 0; iy < dataMonthtot.length; iy++) {
                            const year = dataMonthtot[iy][0].slice(-2);
                            const month = dataMonthtot[iy][0].slice(3, 5);

                            if (dataMonthtot[iy][1]) {
                                await adapter.setStateAsync(
                                    `Historic.20${year}.monthly.${month}.yieldmonth`,
                                    dataMonthtot[iy][1],
                                    true,
                                );
                                await adapter.setStateAsync(
                                    `Historic.20${year}.monthly.${month}.consmonth`,
                                    dataMonthtot[iy][2],
                                    true,
                                );
                                await adapter.setStateAsync(
                                    `Historic.20${year}.monthly.${month}.selfconsmonth`,
                                    dataMonthtot[iy][3],
                                    true,
                                );
                            }
                        }

                        await adapter.setStateAsync(
                            'SelfCons.selfconsmonth',
                            dataMonthtot[dataMonthtot.length - 1][3],
                            true,
                        );
                        await adapter.setStateAsync(
                            'SelfCons.selfconslastmonth',
                            dataMonthtot[dataMonthtot.length - 2][3],
                            true,
                        );

                        await adapter.setStateAsync(
                            'SelfCons.selfconsratiomonth',
                            Math.round(
                                ((dataMonthtot[dataMonthtot.length - 1][3] * 1000) /
                                    dataMonthtot[dataMonthtot.length - 1][2]) *
                                    1000,
                            ) / 10,
                            true,
                        );
                        await adapter.setStateAsync(
                            'SelfCons.selfconsratiolastmonth',
                            Math.round(
                                ((dataMonthtot[dataMonthtot.length - 2][3] * 1000) /
                                    dataMonthtot[dataMonthtot.length - 2][2]) *
                                    1000,
                            ) / 10,
                            true,
                        );
                    } catch (e) {
                        adapter.log.warn(`readSolarlogData - error in historic monthly: ${e}`);
                        throw e;
                    }

                    try {
                        //878":null}
                        const dataYeartot = JSON.parse(resData)[878];
                        adapter.log.debug(`DataYear: ${dataYeartot}`);

                        for (let iy = 0; iy < dataYeartot.length; iy++) {
                            const year = dataYeartot[iy][0].slice(-2);

                            await adapter.setObjectNotExistsAsync(`Historic.20${year}.yieldyear`, {
                                type: 'state',
                                common: {
                                    name: 'yieldyear',
                                    desc: 'Year sum production Wh',
                                    type: 'number',
                                    role: 'value.yearsum',
                                    read: true,
                                    write: false,
                                    unit: 'Wh',
                                },
                                native: {},
                            });

                            await adapter.setObjectNotExistsAsync(`Historic.20${year}.consyear`, {
                                type: 'state',
                                common: {
                                    name: 'consyear',
                                    desc: 'Year sum consumption Wh',
                                    type: 'number',
                                    role: 'value.yearsum',
                                    read: true,
                                    write: false,
                                    unit: 'Wh',
                                },
                                native: {},
                            });

                            await adapter.setObjectNotExistsAsync(`Historic.20${year}.selfconsyear`, {
                                type: 'state',
                                common: {
                                    name: 'selfconsyear',
                                    desc: 'Year sum  self consumption Wh',
                                    type: 'number',
                                    role: 'value.yearsum',
                                    read: true,
                                    write: false,
                                    unit: 'kWh',
                                },
                                native: {},
                            });
                        }

                        for (let iy = 0; iy < dataYeartot.length; iy++) {
                            const year = dataYeartot[iy][0].slice(-2);
                            if (dataYeartot[iy][1]) {
                                await adapter.setStateAsync(`Historic.20${year}.yieldyear`, dataYeartot[iy][1], true);
                                await adapter.setStateAsync(`Historic.20${year}.consyear`, dataYeartot[iy][2], true);
                                await adapter.setStateAsync(
                                    `Historic.20${year}.selfconsyear`,
                                    dataYeartot[iy][3],
                                    true,
                                );
                            }
                        }

                        await adapter.setStateAsync(
                            'SelfCons.selfconsyear',
                            dataYeartot[dataYeartot.length - 1][3],
                            true,
                        );
                        await adapter.setStateAsync(
                            'SelfCons.selfconslastyear',
                            dataYeartot[dataYeartot.length - 2][3],
                            true,
                        );

                        await adapter.setStateAsync(
                            'SelfCons.selfconsratioyear',
                            Math.round(
                                ((dataYeartot[dataYeartot.length - 1][3] * 1000) /
                                    dataYeartot[dataYeartot.length - 1][2]) *
                                    1000,
                            ) / 10,
                            true,
                        );
                        await adapter.setStateAsync(
                            'SelfCons.selfconsratiolastyear',
                            Math.round(
                                ((dataYeartot[dataYeartot.length - 2][3] * 1000) /
                                    dataYeartot[dataYeartot.length - 2][2]) *
                                    1000,
                            ) / 10,
                            true,
                        );
                    } catch (e) {
                        adapter.log.warn(`readSolarlogData - error in status historic sum data: ${e}`);
                        throw e;
                    }
                }
                break;

            case '{"801"': //nur Daten über offene JSON-Schnittstelle'
                try {
                    json = JSON.parse(resData)[801][170];
                    adapter.log.debug(`Data open JSON: ${JSON.stringify(json)}`);
                    await adapter.setStateAsync('info.lastSync', json[100], true);
                    await adapter.setStateAsync('info.totalPower', parseInt(json[116]), true);
                    await adapter.setStateAsync('status.pac', parseInt(json[101]), true);
                    await adapter.setStateAsync('status.pdc', parseInt(json[102]), true);
                    await adapter.setStateAsync('status.uac', parseInt(json[103]), true);
                    await adapter.setStateAsync('status.udc', parseInt(json[104]), true);
                    await adapter.setStateAsync('status.conspac', parseInt(json[110]), true);
                    await adapter.setStateAsync('status.yieldday', parseInt(json[105]), true);
                    await adapter.setStateAsync('status.yieldyesterday', parseInt(json[106]), true);
                    await adapter.setStateAsync('status.yieldmonth', parseInt(json[107]), true);
                    await adapter.setStateAsync('status.yieldyear', parseInt(json[108]), true);
                    await adapter.setStateAsync('status.yieldtotal', parseInt(json[109]), true);
                    await adapter.setStateAsync('status.consyieldday', parseInt(json[111]), true);
                    await adapter.setStateAsync('status.consyieldyesterday', parseInt(json[112]), true);
                    await adapter.setStateAsync('status.consyieldmonth', parseInt(json[113]), true);
                    await adapter.setStateAsync('status.consyieldyear', parseInt(json[114]), true);
                    await adapter.setStateAsync('status.consyieldtotal', parseInt(json[115]), true);
                } catch (e) {
                    adapter.log.warn(`readSolarlogData - error in standard data request: ${e}`);
                    throw e;
                }
                break;

            default:
                adapter.log.warn('error in data evaluation, no solarlog data recognized');
        }
    } catch (e) {
        adapter.log.warn(`readSolarlogData - error : ${e}`);
    }
} //end readSolarlogData

async function readSolarlogDataJson(reqData, resData) {
    try {
        adapter.log.debug('processing data');
        adapter.log.debug(`data set: ${reqData}`);
        adapter.log.debug(`evaluation data: ${resData}`);

        switch (reqData) {
            case '/years.json?_=':
                try {
                    const dataYeartotj = JSON.parse(resData);

                    adapter.log.debug(`DataYear: ${dataYeartotj}`);

                    for (let iy = 0; iy < dataYeartotj.length; iy++) {
                        const year = dataYeartotj[iy][0].slice(-2);

                        await adapter.setObjectNotExistsAsync(`Historic.20${year}.yieldyear`, {
                            type: 'state',
                            common: {
                                name: 'yieldyear',
                                desc: 'Year sum production Wh',
                                type: 'number',
                                role: 'value.yearsum',
                                read: true,
                                write: false,
                                unit: 'Wh',
                            },
                            native: {},
                        });

                        await adapter.setObjectNotExistsAsync(`Historic.20${year}.consyear`, {
                            type: 'state',
                            common: {
                                name: 'consyear',
                                desc: 'Year sum consumption Wh',
                                type: 'number',
                                role: 'value.yearsum',
                                read: true,
                                write: false,
                                unit: 'Wh',
                            },
                            native: {},
                        });

                        await adapter.setObjectNotExistsAsync(`Historic.20${year}.selfconsyear`, {
                            type: 'state',
                            common: {
                                name: 'selfconsyear',
                                desc: 'Year sum  self consumption Wh',
                                type: 'number',
                                role: 'value.yearsum',
                                read: true,
                                write: false,
                                unit: 'kWh',
                            },
                            native: {},
                        });
                    }

                    for (let iy = 0; iy < dataYeartotj.length; iy++) {
                        const year = dataYeartotj[iy][0].slice(-2);
                        if (dataYeartotj[iy][1]) {
                            await adapter.setStateAsync(`Historic.20${year}.yieldyear`, dataYeartotj[iy][1], true);
                            await adapter.setStateAsync(`Historic.20${year}.consyear`, dataYeartotj[iy][2], true);
                            await adapter.setStateAsync(`Historic.20${year}.selfconsyear`, dataYeartotj[iy][3], true);
                        }
                    }
                    adapter.log.debug(`SelfCons.selfconsyear: ${dataYeartotj[0][3]}`);
                    adapter.log.debug(`SelfCons.selfconslastyear: ${dataYeartotj[1][3]}`);

                    await adapter.setStateAsync('SelfCons.selfconsyear', dataYeartotj[0][3], true);
                    await adapter.setStateAsync('SelfCons.selfconslastyear', dataYeartotj[1][3], true);

                    adapter.log.debug(
                        `SelfCons.selfconsratioyear: ${Math.round(((dataYeartotj[0][3] * 1000) / dataYeartotj[0][2]) * 1000) / 10}`,
                    );
                    adapter.log.debug(
                        `SelfCons.selfconsratiolastyear: ${Math.round(((dataYeartotj[1][3] * 1000) / dataYeartotj[1][2]) * 1000) / 10}`,
                    );

                    await adapter.setStateAsync(
                        'SelfCons.selfconsratioyear',
                        Math.round(((dataYeartotj[0][3] * 1000) / dataYeartotj[0][2]) * 1000) / 10,
                        true,
                    );
                    await adapter.setStateAsync(
                        'SelfCons.selfconsratiolastyear',
                        Math.round(((dataYeartotj[1][3] * 1000) / dataYeartotj[1][2]) * 1000) / 10,
                        true,
                    );
                } catch (e) {
                    adapter.log.warn(`readSolarlogDatajson - years - error : ${e}`);
                }
                break;

            case '/months.json?_=':
                try {
                    const dataMonthtotj = JSON.parse(resData);

                    adapter.log.debug(`DataMonthj: ${dataMonthtotj}`);

                    for (let iy = 0; iy < dataMonthtotj.length; iy++) {
                        const year = dataMonthtotj[iy][0].slice(-2);
                        const month = dataMonthtotj[iy][0].slice(3, 5);

                        await adapter.setObjectNotExistsAsync(`Historic.20${year}.monthly.${month}.yieldmonth`, {
                            type: 'state',
                            common: {
                                name: 'yieldmonth',
                                desc: 'Month sum production Wh',
                                type: 'number',
                                role: 'value.monthsum',
                                read: true,
                                write: false,
                                unit: 'Wh',
                            },
                            native: {},
                        });

                        await adapter.setObjectNotExistsAsync(`Historic.20${year}.monthly.${month}.consmonth`, {
                            type: 'state',
                            common: {
                                name: 'consmonth',
                                desc: 'Month sum consumption Wh',
                                type: 'number',
                                role: 'value.monthsum',
                                read: true,
                                write: false,
                                unit: 'Wh',
                            },
                            native: {},
                        });

                        await adapter.setObjectNotExistsAsync(`Historic.20${year}.monthly.${month}.selfconsmonth`, {
                            type: 'state',
                            common: {
                                name: 'selfconsmonth',
                                desc: 'Month sum  self consumption Wh',
                                type: 'number',
                                role: 'value.monthsum',
                                read: true,
                                write: false,
                                unit: 'kWh',
                            },
                            native: {},
                        });
                    }

                    for (let iy = 0; iy < dataMonthtotj.length; iy++) {
                        const year = dataMonthtotj[iy][0].slice(-2);
                        const month = dataMonthtotj[iy][0].slice(3, 5);

                        if (dataMonthtotj[iy][1]) {
                            await adapter.setStateAsync(
                                `Historic.20${year}.monthly.${month}.yieldmonth`,
                                dataMonthtotj[iy][1],
                                true,
                            );
                            await adapter.setStateAsync(
                                `Historic.20${year}.monthly.${month}.consmonth`,
                                dataMonthtotj[iy][2],
                                true,
                            );
                            await adapter.setStateAsync(
                                `Historic.20${year}.monthly.${month}.selfconsmonth`,
                                dataMonthtotj[iy][3],
                                true,
                            );
                        }
                    }

                    adapter.log.debug(`SelfCons.selfconsmonth: ${dataMonthtotj[0][3]}`);
                    adapter.log.debug(`SelfCons.selfconslastmonth: ${dataMonthtotj[1][3]}`);

                    await adapter.setStateAsync('SelfCons.selfconsmonth', dataMonthtotj[0][3], true);
                    await adapter.setStateAsync('SelfCons.selfconslastmonth', dataMonthtotj[1][3], true);

                    adapter.log.debug(
                        `SelfCons.selfconsratiomonth: ${Math.round(((dataMonthtotj[0][3] * 1000) / dataMonthtotj[0][2]) * 1000) / 10}`,
                    );
                    adapter.log.debug(
                        `SelfCons.selfconsratiolastmonth: ${Math.round(((dataMonthtotj[1][3] * 1000) / dataMonthtotj[1][2]) * 1000) / 10}`,
                    );

                    await adapter.setStateAsync(
                        'SelfCons.selfconsratiomonth',
                        Math.round(((dataMonthtotj[0][3] * 1000) / dataMonthtotj[0][2]) * 1000) / 10,
                        true,
                    );
                    await adapter.setStateAsync(
                        'SelfCons.selfconsratiolastmonth',
                        Math.round(((dataMonthtotj[1][3] * 1000) / dataMonthtotj[1][2]) * 1000) / 10,
                        true,
                    );
                } catch (e) {
                    adapter.log.warn(`readSolarlogDatajson - month - error : ${e}`);
                }
                break;

            default:
                adapter.log.warn('error in JSON data processing, no solarlog data recognized');
        }
    } catch (e) {
        adapter.log.warn(`readSolarlogDatajson - error : ${e}`);
    }
} //end readSolarlogDatajson

async function defDeviceInfo() {
    // Geräteinfos httpsReqGetUzDeviceinfo
    try {
        const namLeng = names.length;
        for (let y = 0; y < namLeng; y++) {
            adapter.log.debug(`INV.${names[y]}.devicetype: ${deviceList[deviceinfos[y]][1]}`);
            devicetypes.push(deviceList[deviceinfos[y]][1]);

            adapter.log.debug(`INV.${names[y]}.devicebrand: ${brandlist[deviceList[deviceinfos[y]][0]]}`);
            devicebrands.push(brandlist[deviceList[deviceinfos[y]][0]]);

            deviceclasses.push(deviceClassList[Math.log(deviceList[deviceinfos[y]][5]) / Math.LN2]);

            if (deviceClassList[Math.log(deviceList[deviceinfos[y]][5]) / Math.LN2] === 'Batterie') {
                battDevicePresent = true;
                adapter.log.debug('Battery as device available');
                battindex[battarrind] = y;
                adapter.log.debug(`Index battery device: ${y}`);
                battarrind++;

                adapter.log.debug(
                    `INV.${names[y]}.deviceclass: ${deviceClassList[Math.log(deviceList[deviceinfos[y]][5]) / Math.LN2]}`,
                );
            }

            adapter.log.debug(`Battery as divice: ${battDevicePresent}`);
        }

        adapter.log.debug(`Devicetypes: ${devicetypes}`);
        adapter.log.debug(`Devicebrands: ${devicebrands}`);
        adapter.log.debug(`Deviceclasses: ${deviceclasses}`);

        if (names.length > 0 && deviceclasses.length > 0) {
            await setInvObjects();
        }
    } catch (e) {
        adapter.log.warn(`defdeviceinfo - Error: ${e.message}`);
    }
} // end defdeviceinfo

async function setInvObjects() {
    // create Channel Inverter(i)
    try {
        adapter.log.debug('laying out objects, if not existing');
        adapter.log.debug(`NumInv Obj: ${numinv}`);
        adapter.log.debug(`Names to lay ou: ${names}`);
        adapter.log.debug(`Number of swichtgroups: ${numsg}`);
        adapter.log.debug(`switchgrous: ${namessg}`);

        for (let i = 0; i < numinv - 1; i++) {
            await adapter.setObjectNotExistsAsync(`INV.${names[i]}`, {
                type: 'channel',
                role: '',
                common: {
                    name: `${names[i]}`,
                },
                native: {},
            });

            // create States PAC/Status/DaySum Inverter(i)
            if (deviceclasses[i] !== 'Batterie') {
                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.PAC`, {
                    type: 'state',
                    common: {
                        name: 'PAC',
                        desc: 'Power AC',
                        type: 'number',
                        role: 'value.pac',
                        read: true,
                        write: false,
                        unit: 'W',
                    },
                    native: {},
                });
            }

            await adapter.setObjectNotExistsAsync(`INV.${names[i]}.status`, {
                type: 'state',
                common: {
                    name: 'status',
                    desc: 'Staus of Inverter',
                    type: 'string',
                    role: 'info.status',
                    read: true,
                    write: false,
                },
                native: {},
            });

            if (deviceclasses[i] !== 'Batterie') {
                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.daysum`, {
                    type: 'state',
                    common: {
                        name: 'DaySum',
                        desc: 'Daily sum Wh',
                        type: 'number',
                        role: 'value.daysum',
                        read: true,
                        write: false,
                        unit: 'Wh',
                    },
                    native: {},
                });

                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.yieldmonth`, {
                    type: 'state',
                    common: {
                        name: 'MonthSum',
                        desc: 'Monthly sum Wh (running total for the current month, adapter-side accumulation)',
                        type: 'number',
                        role: 'value.monthsum',
                        read: true,
                        write: false,
                        unit: 'Wh',
                    },
                    native: {},
                });

                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.yieldtotal`, {
                    type: 'state',
                    common: {
                        name: 'Zaehlerstand',
                        desc: 'Lifetime meter reading Wh (never resets, adapter-side accumulation since first start)',
                        type: 'number',
                        role: 'value.total',
                        read: true,
                        write: false,
                        unit: 'Wh',
                    },
                    native: {},
                });
            }

            await adapter.setObjectNotExistsAsync(`INV.${names[i]}.deviceclass`, {
                type: 'state',
                common: {
                    name: 'DeviceClass',
                    desc: 'Device Class',
                    type: 'string',
                    role: 'value.deviceclass',
                    read: true,
                    write: false,
                },
                native: {},
            });

            await adapter.setObjectNotExistsAsync(`INV.${names[i]}.devicebrand`, {
                type: 'state',
                common: {
                    name: 'DeviceBrand',
                    desc: 'Device brand',
                    type: 'string',
                    role: 'value.devicebrand',
                    read: true,
                    write: false,
                },
                native: {},
            });

            await adapter.setObjectNotExistsAsync(`INV.${names[i]}.devicetype`, {
                type: 'state',
                common: {
                    name: 'DeviceType',
                    desc: 'Device type',
                    type: 'string',
                    role: 'value.Devicetype',
                    read: true,
                    write: false,
                },
                native: {},
            });

            if (deviceclasses[i] === 'Batterie' && battDevicePresent && battPresent) {
                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.ChargePower`, {
                    type: 'state',
                    common: {
                        name: 'chargepower',
                        desc: 'Battery charging power',
                        type: 'number',
                        role: 'value.chargepower',
                        read: true,
                        write: false,
                        unit: 'W',
                    },
                    native: {},
                });

                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.DischargePower`, {
                    type: 'state',
                    common: {
                        name: 'dischargepower',
                        desc: 'Battery discharging power',
                        type: 'number',
                        role: 'value.dischargepower',
                        read: true,
                        write: false,
                        unit: 'W',
                    },
                    native: {},
                });

                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.BattLevel`, {
                    type: 'state',
                    common: {
                        name: 'battlevel',
                        desc: 'Battery Level',
                        type: 'number',
                        role: 'value.battlevel',
                        read: true,
                        write: false,
                        unit: '%',
                    },
                    native: {},
                });

                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.BattSelfCons`, {
                    type: 'state',
                    common: {
                        name: 'battselfcons',
                        desc: 'Battery self consumption',
                        type: 'number',
                        role: 'value.battselfcons',
                        read: true,
                        write: false,
                        unit: 'Wh',
                    },
                    native: {},
                });

                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.BattChargeDaysum`, {
                    type: 'state',
                    common: {
                        name: 'battchargedaysum',
                        desc: 'Total battery charged today',
                        type: 'number',
                        role: 'value.battchargedaysum',
                        read: true,
                        write: false,
                        unit: 'Wh',
                    },
                    native: {},
                });

                await adapter.setObjectNotExistsAsync(`INV.${names[i]}.BattDischargeDaysum`, {
                    type: 'state',
                    common: {
                        name: 'battdischargedaysum',
                        desc: 'Total battery diesemcharged today',
                        type: 'number',
                        role: 'value.battdischargedaysum',
                        read: true,
                        write: false,
                        unit: 'Wh',
                    },
                    native: {},
                });
            }
        }

        if (!battDevicePresent && battPresent) {
            await adapter.setObjectNotExistsAsync(`INV.Battery.ChargePower`, {
                type: 'state',
                common: {
                    name: 'chargepower',
                    desc: 'Battery charging power',
                    type: 'number',
                    role: 'value.chargepower',
                    read: true,
                    write: false,
                    unit: 'W',
                },
                native: {},
            });

            await adapter.setObjectNotExistsAsync(`INV.Battery.DischargePower`, {
                type: 'state',
                common: {
                    name: 'dischargepower',
                    desc: 'Battery discharging power',
                    type: 'number',
                    role: 'value.dischargepower',
                    read: true,
                    write: false,
                    unit: 'W',
                },
                native: {},
            });

            await adapter.setObjectNotExistsAsync(`INV.Battery.BattLevel`, {
                type: 'state',
                common: {
                    name: 'battlevel',
                    desc: 'Battery Level',
                    type: 'number',
                    role: 'value.battlevel',
                    read: true,
                    write: false,
                    unit: '%',
                },
                native: {},
            });

            await adapter.setObjectNotExistsAsync(`INV.Battery.BattSelfCons`, {
                type: 'state',
                common: {
                    name: 'battselfcons',
                    desc: 'Battery self consumption',
                    type: 'number',
                    role: 'value.battselfcons',
                    read: true,
                    write: false,
                    unit: 'Wh',
                },
                native: {},
            });

            await adapter.setObjectNotExistsAsync(`INV.Battery.BattChargeDaysum`, {
                type: 'state',
                common: {
                    name: 'battchargedaysum',
                    desc: 'Total battery charged today',
                    type: 'number',
                    role: 'value.battchargedaysum',
                    read: true,
                    write: false,
                    unit: 'Wh',
                },
                native: {},
            });

            await adapter.setObjectNotExistsAsync(`INV.Battery.BattDischargeDaysum`, {
                type: 'state',
                common: {
                    name: 'battdischargedaysum',
                    desc: 'Total battery diesemcharged today',
                    type: 'number',
                    role: 'value.battdischargedaysum',
                    read: true,
                    write: false,
                    unit: 'Wh',
                },
                native: {},
            });
        }

        if (numsg > 0) {
            for (let jsg = 0; jsg < 10; jsg++) {
                if (namessg[jsg]) {
                    await adapter.setObjectNotExistsAsync(`SwitchGroup.${namessg[jsg]}.mode`, {
                        type: 'state',
                        common: {
                            name: 'swichtgroupmode',
                            desc: 'shows set mode on/auto/off',
                            type: 'number',
                            states: {
                                0: 'OFF',
                                1: 'ON',
                                2: 'AUTO',
                            },
                            role: 'value.switchgroupmode',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });

                    await adapter.setObjectNotExistsAsync(`SwitchGroup.${namessg[jsg]}.state`, {
                        type: 'state',
                        common: {
                            name: 'swichtgroupstate',
                            desc: 'shows set mode on/auto/off',
                            type: 'number',
                            states: {
                                0: 'OFF',
                                240: 'Switching',
                                255: 'ON',
                            },
                            role: 'value.switchgroupstate',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });

                    await adapter.setObjectNotExistsAsync(`SwitchGroup.${namessg[jsg]}.linkeddev`, {
                        type: 'state',
                        common: {
                            name: 'swichtgrouplinkeddev',
                            desc: 'Hardware linked to SwitchGroup',
                            type: 'string',

                            role: 'value.switchgrouplinkeddev',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });

                    await adapter.setObjectNotExistsAsync(`SwitchGroup.${namessg[jsg]}.linkeddevsub`, {
                        type: 'state',
                        common: {
                            name: 'swichtgrouplinkeddevsub',
                            desc: 'Sub-device of hardware linked to SwitchGroup (if existing)',
                            type: 'number',

                            role: 'value.switchgrouplinkeddevsub',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                }
            }
        }

        await adapter.setObjectNotExistsAsync('SelfCons.selfconstoday', {
            type: 'state',
            common: {
                name: 'selfconstoday',
                desc: 'Total self consumption today',
                type: 'number',
                role: 'value.selfconstoday',
                read: true,
                write: false,
                unit: 'Wh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconsyesterday', {
            type: 'state',
            common: {
                name: 'selfconsyesterday',
                desc: 'Total self consumption yesterday',
                type: 'number',
                role: 'value.selfconsyesterday',
                read: true,
                write: false,
                unit: 'Wh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconsmonth', {
            type: 'state',
            common: {
                name: 'selfconsmonth',
                desc: 'Total self consumption this month',
                type: 'number',
                role: 'value.selfconsmonth',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconslastmonth', {
            type: 'state',
            common: {
                name: 'selfconslastmonth',
                desc: 'Total self consumption last month',
                type: 'number',
                role: 'value.selfconslastmonth',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconsyear', {
            type: 'state',
            common: {
                name: 'selfconsyear',
                desc: 'Total self consumption year',
                type: 'number',
                role: 'value.selfconsyear',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconslastyear', {
            type: 'state',
            common: {
                name: 'selfconslastyear',
                desc: 'Total self consumption last year',
                type: 'number',
                role: 'value.selfconslastyear',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconsratiotoday', {
            type: 'state',
            common: {
                name: 'selfconsratiotoday',
                desc: 'Self consumption ratio today',
                type: 'number',
                role: 'value.selfconsratiotoday',
                read: true,
                write: false,
                unit: '%',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconsratioyesterday', {
            type: 'state',
            common: {
                name: 'selfconsratioyesterday',
                desc: 'self consumption ratio yesterday',
                type: 'number',
                role: 'value.selfconsratioyesterday',
                read: true,
                write: false,
                unit: '%',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconsratiomonth', {
            type: 'state',
            common: {
                name: 'selfconratiosmonth',
                desc: 'self consumption ratio this month',
                type: 'number',
                role: 'value.selfconsratiomonth',
                read: true,
                write: false,
                unit: '%',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconsratiolastmonth', {
            type: 'state',
            common: {
                name: 'selfconsratiolastmonth',
                desc: 'self consumption ratio last month',
                type: 'number',
                role: 'value.selfconsratiolastmonth',
                read: true,
                write: false,
                unit: '%',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconsratioyear', {
            type: 'state',
            common: {
                name: 'selfconsratioyear',
                desc: 'self consumption ratio year',
                type: 'number',
                role: 'value.selfconsratioyear',
                read: true,
                write: false,
                unit: '%',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('SelfCons.selfconsratiolastyear', {
            type: 'state',
            common: {
                name: 'selfconsratiolastyear',
                desc: 'self consumption ratio last year',
                type: 'number',
                role: 'value.selfconsratiolastyear',
                read: true,
                write: false,
                unit: '%',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.RTOS', {
            type: 'state',
            common: {
                name: 'RTOS',
                desc: 'RTOS',
                type: 'string',
                role: 'value.RTOS',
                read: true,
                write: false,
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.CLIB', {
            type: 'state',
            common: {
                name: 'CLIB',
                desc: 'CLIB',
                type: 'string',
                role: 'value.CLIB',
                read: true,
                write: false,
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.MAC', {
            type: 'state',
            common: {
                name: 'MAC-Adress',
                desc: 'MAC-Adress',
                type: 'string',
                role: 'value.MAC',
                read: true,
                write: false,
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.SN', {
            type: 'state',
            common: {
                name: 'Serial Number',
                desc: 'Serial Number',
                type: 'string',
                role: 'value.SN',
                read: true,
                write: false,
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.Model', {
            type: 'state',
            common: {
                name: 'Model - Number',
                desc: 'Model - Number (SolarLog XX)',
                type: 'string',
                role: 'value.Model',
                read: true,
                write: false,
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.InstDate', {
            type: 'state',
            common: {
                name: 'Installation - date',
                desc: 'Installation - date',
                type: 'string',
                role: 'value.InstDate',
                read: true,
                write: false,
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.FW', {
            type: 'state',
            common: {
                name: 'Firmware version',
                desc: 'Firmware version',
                type: 'string',
                role: 'value.FW',
                read: true,
                write: false,
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.FWrelD', {
            type: 'state',
            common: {
                name: 'Firmware realease date',
                desc: 'Firmware realease date',
                type: 'string',
                role: 'value.FWrelD',
                read: true,
                write: false,
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.SD', {
            type: 'state',
            common: {
                name: 'SC card info',
                desc: 'SC card info',
                type: 'string',
                role: 'value.SD',
                read: true,
                write: false,
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointToday', {
            type: 'state',
            common: {
                name: 'setpointToday',
                desc: 'todays production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.01', {
            type: 'state',
            common: {
                name: 'setpointJAN',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.02', {
            type: 'state',
            common: {
                name: 'setpointFEB',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.03', {
            type: 'state',
            common: {
                name: 'setpointMAR',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.04', {
            type: 'state',
            common: {
                name: 'setpointAPR',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.05', {
            type: 'state',
            common: {
                name: 'setpointMAY',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.06', {
            type: 'state',
            common: {
                name: 'setpointJUN',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.07', {
            type: 'state',
            common: {
                name: 'setpointJUL',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.08', {
            type: 'state',
            common: {
                name: 'setpointAUG',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.09', {
            type: 'state',
            common: {
                name: 'setpointSEP',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.10', {
            type: 'state',
            common: {
                name: 'setpointOCT',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.11', {
            type: 'state',
            common: {
                name: 'setpointNOV',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointMonth.12', {
            type: 'state',
            common: {
                name: 'setpointDEC',
                desc: 'monthly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointYear', {
            type: 'state',
            common: {
                name: 'setpoint current year',
                desc: 'yearly production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.setpointCurrMonth', {
            type: 'state',
            common: {
                name: 'setpoint current month',
                desc: 'monthly (current) production estimation',
                type: 'number',
                role: 'value.setpoint',
                read: true,
                write: false,
                unit: 'kWh',
            },
            native: {},
        });
    } catch (e) {
        adapter.log.warn(`setInvObjects - Error: ${e.message}`);
    }
} //End setInvObjects

async function setDeviceInfo() {
    try {
        for (let i = 0; i < numinv - 1; i++) {
            if (deviceclasses[i]) {
                await adapter.setStateAsync(`INV.${names[i]}.deviceclass`, deviceclasses[i], true);
            }
            if (devicetypes[i]) {
                await adapter.setStateAsync(`INV.${names[i]}.devicetype`, devicetypes[i], true);
            }
            if (devicebrands[i]) {
                await adapter.setStateAsync(`INV.${names[i]}.devicebrand`, devicebrands[i], true);
            }
        }
    } catch (e) {
        adapter.log.warn(`setDeviceInfo - Error: ${e.message}`);
    }
    if (forecast) {
        await setForecastObjects();
    } else {
        await logCheck(pollingData);
    }
} //End setdeviceinfo

async function setForecastObjects() {
    try {
        adapter.log.debug('laying out forecast objects');

        await adapter.setObjectNotExistsAsync('info.latitude', {
            type: 'state',
            common: {
                name: 'latitude',
                desc: 'plant latitude',
                type: 'string',
                role: 'value.latitude',
                read: true,
                write: false,
                unit: '°',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.longitude', {
            type: 'state',
            common: {
                name: 'longitude',
                desc: 'plant longitude',
                type: 'string',
                role: 'value.longitude',
                read: true,
                write: false,
                unit: '°',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.inclination', {
            type: 'state',
            common: {
                name: 'inclination',
                desc: 'plant inclination',
                type: 'string',
                role: 'value.inclination',
                read: true,
                write: false,
                unit: '°',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('info.azimuth', {
            type: 'state',
            common: {
                name: 'azimuth',
                desc: 'plant azimuth',
                type: 'string',
                role: 'value.azimuth',
                read: true,
                write: false,
                unit: '°',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.today', {
            type: 'state',
            common: {
                name: 'forecastToday',
                desc: 'forecast for todays total kWh',
                type: 'number',
                role: 'value.forecastToday',
                read: true,
                write: false,
                unit: 'Wh',
            },
            native: {},
        });

        await adapter.setObjectNotExistsAsync('forecast.tomorrow', {
            type: 'state',
            common: {
                name: 'forecastTomorrow',
                desc: 'forecast for tomorrows total kWh',
                type: 'number',
                role: 'value.forecastTomorrow',
                read: true,
                write: false,
                unit: 'Wh',
            },
            native: {},
        });

        await getForecastData();

        setTimeout(async () => {
            if (uzimp) {
                await logCheck(pollingData);
            } else {
                await logCheck(['{"801":{"170":null}}']);
            }
        }, 1000);
    } catch (e) {
        adapter.log.warn(`setForecastObjects - Error: ${e.message}`);
    }
} //end setforecastobjects()

async function getForecastData() {
    try {
        adapter.log.debug('getting forecast data');
        cmdForecast = 'estimate/watthours/day/';
        lat = adapter.config.latitude;
        lon = adapter.config.longitude;
        dec = adapter.config.inclination;
        az = adapter.config.azimuth;
        const objkwp = await adapter.getStateAsync('info.totalPower');
        if (objkwp) {
            kwp = objkwp.val / 1000;

            const urlProg = `${urlForecast + cmdForecast + lat}/${lon}/${dec}/${az}/${kwp}`;
            adapter.log.debug(`request data: ${urlProg}`);

            https
                .get(urlProg, res => {
                    let data = [];
                    const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date';
                    adapter.log.debug('Status Code:', res.statusCode);
                    adapter.log.debug('Date in Response header:', headerDate);

                    res.on('data', chunk => data.push(chunk));

                    res.on('end', async () => {
                        adapter.log.debug('Response ended: ');

                        try {
                            const forecast = JSON.parse(Buffer.concat(data).toString());
                            adapter.log.debug(`forecast: ${JSON.stringify(forecast)}`);

                            if (forecast.message.type === 'success') {
                                const watthoursday = forecast.result;
                                adapter.log.debug(`WatthoursDay = ${JSON.stringify(watthoursday)}`);
                                const watthourstoday = parseInt(forecast.result[new Date().toISOString().slice(0, 10)]);
                                adapter.log.debug(
                                    `forecast for today, ${new Date().toISOString().slice(0, 10)}: ${watthourstoday}`,
                                );
                                const tomorrow = new Date();
                                tomorrow.setDate(new Date().getDate() + 1);
                                const watthourstomorrow = parseInt(
                                    forecast.result[tomorrow.toISOString().slice(0, 10)],
                                );
                                adapter.log.debug(
                                    `forecast for tomorrow, ${tomorrow.toISOString().slice(0, 10)}: ${watthourstomorrow}`,
                                );

                                await adapter.setStateAsync('forecast.today', parseInt(watthourstoday, 10), true);
                                await adapter.setStateAsync('forecast.tomorrow', parseInt(watthourstomorrow, 10), true);
                                await adapter.setStateAsync('info.latitude', lat, true);
                                await adapter.setStateAsync('info.longitude', lon, true);
                                await adapter.setStateAsync('info.inclination', dec, true);
                                await adapter.setStateAsync('info.azimuth', az, true);
                            } else {
                                adapter.log.warn('forecast error, no forecast data available');
                                adapter.log.info(`response type: ${forecast.message.type}`);
                                adapter.log.info(`response text: ${forecast.message.text}`);
                                adapter.log.info(
                                    `requests remaining (Limit:12): ${forecast.message.ratelimit.reamining}`,
                                );
                                adapter.log.info(`response type: ${JSON.stringify(forecast.message)}`);
                            }
                        } catch (e) {
                            adapter.log.warn(`Getforecastdata - Error: ${e}`);
                        }
                    });
                })
                .on('error', err => console.log('Error: ', err.message));
        } else {
            adapter.log.warn('forecast error, installed power not available');
        }
    } catch (e) {
        adapter.log.warn(`getForecastData - Error: ${e.message}`);
    }
} //end getforecastdata()

async function setDisplayData(displaydata) {
    try {
        const checkOK = [];
        for (let di = 0; di <= 15; di++) {
            checkOK[di] = displaydata[di][1];
        }

        const checkError = errval => !errval;

        adapter.log.debug(`Display OK?: ${checkOK.every(checkError)}`);
        await adapter.setStateAsync('display.OK', checkOK.every(checkError), true);

        adapter.log.debug(`Display Icon Inverter: ${displaydata[0][0]}`);
        await adapter.setStateAsync('display.invicon', displaydata[0][0], true);
        adapter.log.debug(`Display Icon Network: ${displaydata[1][0]}`);
        await adapter.setStateAsync('display.networkicon', displaydata[1][0], true);
        adapter.log.debug(`Display Icon Meter: ${displaydata[6][0]}`);
        await adapter.setStateAsync('display.metericon', displaydata[6][0], true);
        adapter.log.debug(`Display Icon Mail: ${displaydata[11][0]}`);
        await adapter.setStateAsync('display.mailicon', displaydata[11][0], true);
        adapter.log.debug(`Display Inverter Error: ${displaydata[0][1]}`);
        await adapter.setStateAsync('display.inverror', displaydata[0][1], true);
        adapter.log.debug(`Display Network Error: ${displaydata[1][1]}`);
        await adapter.setStateAsync('display.networkerror', displaydata[1][1], true);
        adapter.log.debug(`Display Meters offline: ${displaydata[6][1]}`);
        await adapter.setStateAsync('display.metersoffline', displaydata[6][1], true);
        adapter.log.debug(`Display Mail Error: ${displaydata[11][1]}`);
        await adapter.setStateAsync('display.mailerror', displaydata[11][1], true);
    } catch (e) {
        adapter.log.warn(`setDisplayData - Error: ${e.message}`);
    }
} //end setdisplaydata

function restartAdapter() {
    adapter.getForeignObject(
        `system.adapter.${adapter.namespace}`,
        (err, obj) => obj && adapter.setForeignObject(`system.adapter.${adapter.namespace}`, obj),
    );
} // endFunctionRestartAdapter

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
} // endElse
