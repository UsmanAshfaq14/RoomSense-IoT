// Room logic tests with a controllable clock: bookings, check-in, no-show, release, walk-in, actuator rules,
// overrides, air alert, timetable import and energy statistics. No network, no Pi.
// Run: node test/rules.js
const { createApp, hashUid } = require('../server');
const { FakeDb } = require('./fake-db');
const { parseTimetable, fullCalendarRooms } = require('../timetable');
const { summarise } = require('../building');
const { resetMeasurements } = require('../scripts/reset-stats');
const { copyForDemo } = require('../scripts/demo-setup');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}
const paris = (s) => new Date(`${s}+01:00`); // November/December: Paris is UTC+1

(async () => {
  const db = new FakeDb();
  await db.collection('users').createIndex({ rfidUidHash: 1 }, { unique: true });
  await db.collection('rooms').insertOne({
    _id: 'ME407', name: 'Study room', state: 'FREE', nodeStatus: 'online', hasNode: true,
    comfortC: 19, ecoC: 16, luxThreshold: 150, lightPowerW: 200, heatingPowerW: 1500, actuators: {}
  });
  const users = db.collection('users');
  const A = (await users.insertOne({ name: 'Usman', role: 'student', rfidUidHash: hashUid('5900BF16C7') })).insertedId;
  const B = (await users.insertOne({ name: 'Zeqi', role: 'student', rfidUidHash: hashUid('5B00AC3725') })).insertedId;
  await users.insertOne({ name: 'Alexandra', role: 'admin', rfidUidHash: hashUid('5F00DBAE13') });

  let clock = paris('2026-11-10T10:00:00');
  const { app, aedes, engine, handleMessage, close } = createApp(db, { room: 'ME407', now: () => clock });
  const sent = [];
  aedes.on('publish', (packet, client) => {
    if (!client && packet.topic.startsWith('campus/')) sent.push({ topic: packet.topic, data: JSON.parse(packet.payload) });
  });
  const http = app.listen(13001);
  const API = 'http://127.0.0.1:13001/api';
  const call = (method, url, body, type = 'application/json') => fetch(`${API}${url}`, {
    method, headers: { 'Content-Type': type }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });

  const msg = (sub, data) => handleMessage(`campus/ME407/${sub}`, Buffer.from(JSON.stringify(data)));
  const climate = (celsius, humidity = 50, gasOhms = 50000) => msg('sensor/climate', { ts: clock / 1000, celsius, humidity, hPa: 993, gasOhms });
  const light = (lux) => msg('sensor/light', { ts: clock / 1000, lux });
  const presence = (p) => msg('sensor/presence', { ts: clock / 1000, presence: p });
  const results = [];
  aedes.on('publish', (packet, client) => { if (!client && packet.topic.endsWith('rfid/result')) results.push(JSON.parse(packet.payload)); });
  const badge = async (uid) => { await msg('sensor/rfid', { ts: clock / 1000, uid }); await new Promise((r) => setImmediate(r)); return results[results.length - 1]; };
  const room = () => db.collection('rooms').findOne({ _id: 'ME407' });
  const last = (name) => [...sent].reverse().find((s) => s.topic.endsWith(`actuator/${name}/set`));
  async function advance(minutes) { for (let i = 0; i < minutes; i += 1) { clock = new Date(clock.getTime() + 60000); await engine.tick(); } }

  // ---- free room: eco heating ----
  await climate(17); await light(50); await engine.tick();
  check('free room heats to eco only (17 C > 16.5: heating off)', last('heating') && last('heating').data.on === false);
  check('free room: status LED free', last('status') && last('status').data.state === 'free');

  // ---- booking, pre-heat ----
  let res = await call('POST', '/bookings', { roomId: 'ME407', userId: String(A), start: paris('2026-11-10T10:20:00').toISOString(), end: paris('2026-11-10T11:20:00').toISOString() });
  check('booking created', res.status === 201);
  res = await call('POST', '/bookings', { roomId: 'ME407', userId: String(B), start: paris('2026-11-10T11:00:00').toISOString(), end: paris('2026-11-10T11:30:00').toISOString() });
  check('overlapping booking refused with 409', res.status === 409);
  res = await call('POST', '/bookings', { roomId: 'ME407', userId: String(B), start: paris('2026-11-10T12:00:00').toISOString(), end: paris('2026-11-10T11:30:00').toISOString() });
  check('end before start refused with 400', res.status === 400);
  check('still FREE 20 min before the booking', (await room()).state === 'FREE');
  await advance(6);
  check('RESERVED 14 min before: pre-heat window', (await room()).state === 'RESERVED');
  check('pre-heat: heating on (17 C < 19 - 0.5)', last('heating').data.on === true);
  check('status LED reserved', last('status').data.state === 'reserved');
  let ck = (await (await call('GET', '/rooms/ME407')).json()).clock;
  check('room clock: booked, starts 10:20, no-show deadline start + grace', ck.mode === 'booked' && Date.parse(ck.startsAt) === paris('2026-11-10T10:20:00').getTime()
    && Date.parse(ck.noShowAt) === paris('2026-11-10T10:30:00').getTime(), JSON.stringify(ck));

  // ---- check-in ----
  await advance(4); // 10:10
  let r = await badge('5B00AC3725');
  check('another student is refused', r && r.granted === false && /someone else/.test(r.reason), r && r.reason);
  r = await badge('5900BF16C7');
  check('booker checks in early', r && r.granted === true && /checked in/.test(r.reason), r && r.reason);
  check('room OCCUPIED', (await room()).state === 'OCCUPIED');
  await presence(true);
  check('dark + presence: light on', last('light').data.on === true);
  await light(400);
  check('bright daylight: light off', last('light').data.on === false);
  const lightCount = sent.filter((s) => s.topic.endsWith('light/set')).length;
  await light(200);
  check('200 lux stays off (no flicker around the threshold)', sent.filter((s) => s.topic.endsWith('light/set')).length === lightCount);
  await light(100);
  check('100 lux: light on again', last('light').data.on === true);
  r = await badge('5F00DBAE13');
  check('another badge while the booking runs: joins it (no door lock, the badge says who is here)', r && r.granted === true && /joined Usman's booking/.test(r.reason), r && r.reason);
  r = await badge('5B00AC3725');
  check('a third badge joins too', r && r.granted === true && /joined/.test(r.reason), r && r.reason);
  check('the booking lists everyone who badged', ((await db.collection('bookings').findOne({ userId: A, status: 'checked_in' })).attendees || []).length === 3);
  check('...and is still the booker\'s: still OCCUPIED', (await room()).state === 'OCCUPIED');
  ck = (await (await call('GET', '/rooms/ME407')).json()).clock;
  check('room clock: in use, motion now so no release countdown, 3 badged in', ck.mode === 'in_use' && ck.motionNow === true && ck.releaseAt === null && ck.attendees === 3, JSON.stringify(ck));
  await advance(5); // 10:15, people in the room

  // ---- air quality ----
  await climate(19.2, 75);
  check('humidity 75 %: fan on', last('fan').data.on === true);
  await climate(19.2, 64);
  check('humidity 64 %: fan off', last('fan').data.on === false);
  // BME680 warm-up: a low gas value from a sensor still heating up must not raise the alert
  const gasMsg = (gasOhms, gasReady) => msg('sensor/climate', { ts: clock / 1000, celsius: 19.2, humidity: 50, hPa: 993, gasOhms, gasReady });
  await gasMsg(2700, false);
  check('gas 2.7 kOhm while the sensor warms up: no air alert, fan off', last('fan').data.on === false && !engine.live('ME407').airAlert);
  check('warm-up visible on the room', (await room()).gasReady === false);
  await gasMsg(2700, true);
  check('same gas once warmed up: air alert, fan on', last('fan').data.on === true && engine.live('ME407').airAlert);
  await gasMsg(60000, true);
  check('clean air again: fan off', last('fan').data.on === false);

  // ---- manual override, then back to auto ----
  res = await call('POST', '/rooms/ME407/actuators/light', { on: false });
  check('web override sent', res.status === 202);
  const afterOverride = sent.length;
  await light(50); await engine.tick();
  check('override holds: rule does not switch the light back on', !sent.slice(afterOverride).some((s) => s.topic.endsWith('light/set')));
  res = await call('POST', '/rooms/ME407/actuators/light', { mode: 'auto' });
  check('back to auto: rule turns the light on', res.status === 202 && last('light').data.on === true);

  // ---- release when the room empties ----
  const occ = async () => ((await db.collection('daily_stats').findOne({ roomId: 'ME407', date: '2026-11-10' })) || {}).occupiedMin || 0;
  const occBefore = await occ();
  await presence(false);
  await advance(15);
  const occGain = (await occ()) - occBefore;
  // people sitting still trigger the PIR rarely: a minute counts as occupied while motion was seen in the last 15 min
  check('occupancy counts the 15 min after the last motion, not only motion instants', occGain >= 13 && occGain <= 15.5, `${occGain.toFixed(1)} min`);
  check('15 min without motion: light off', last('light').data.on === false);
  check('...but room still OCCUPIED', (await room()).state === 'OCCUPIED');
  await advance(15);
  check('30 min without motion: room released', (await room()).state === 'FREE');
  const released = await db.collection('bookings').findOne({ userId: A, status: 'released' });
  check('booking marked released', Boolean(released));
  await climate(18);
  check('released: heating back to eco (18 C > 16.5: off)', last('heating').data.on === false);

  // ---- no-show ----
  res = await call('POST', '/bookings', { roomId: 'ME407', userId: String(B), start: paris('2026-11-10T11:00:00').toISOString(), end: paris('2026-11-10T11:30:00').toISOString() });
  check('second booking created', res.status === 201);
  clock = paris('2026-11-10T10:59:00'); await engine.tick();
  await advance(12); // 11:11
  const noShow = await db.collection('bookings').findOne({ userId: B, status: 'no_show' });
  check('nobody came: no-show after 10 min grace', Boolean(noShow) && (await room()).state === 'FREE');

  // ---- walk-in and check-out ----
  clock = paris('2026-11-10T12:05:00'); await engine.tick();
  r = await badge('5900BF16C7');
  check('walk-in on a free room', r && r.granted === true && /walk-in until 13:05/.test(r.reason), r && r.reason);
  r = await badge('5900BF16C7');
  check('same badge again: checked out', r && r.granted === true && /checked out/.test(r.reason), r && r.reason);
  check('room FREE after check-out', (await room()).state === 'FREE');
  await call('POST', '/bookings', { roomId: 'ME407', userId: String(B), start: paris('2026-11-10T12:30:00').toISOString(), end: paris('2026-11-10T13:00:00').toISOString() });
  clock = paris('2026-11-10T12:12:00');
  r = await badge('5900BF16C7');
  check('walk-in shortened to end when the next booking starts', r && r.granted === true && /until 12:30/.test(r.reason), r && r.reason);
  r = await badge('5900BF16C7');
  check('checked out again', r && r.granted === true && /checked out/.test(r.reason), r && r.reason);
  clock = paris('2026-11-10T12:20:00'); await engine.tick();
  r = await badge('5900BF16C7');
  check('10 min before someone else\'s booking: refused', r && r.granted === false && /someone else/.test(r.reason), r && r.reason);

  const nResults = results.length;
  await msg('sensor/rfid', { ts: clock / 1000 - 300, uid: '5900BF16C7' });
  check('a badge read 5 min ago (queued during an outage) is ignored', results.length === nResults);
  // Pi clock 9 min behind (no clock battery, booted after a power cut, no time server yet)
  const behind = clock / 1000 - 540;
  await msg('sensor/light', { ts: behind, lux: 120 });
  const lr = await db.collection('sensor_readings').find({ 'meta.type': 'light' }).sort({ ts: -1 }).limit(1).toArray();
  check('Pi clock 9 min behind: the reading is stored at the server\'s time', lr[0].ts.getTime() === clock.getTime(), lr[0].ts.toISOString());
  const nr = results.length;
  await msg('sensor/rfid', { ts: behind, uid: '5900BF16C7' }); await new Promise((r) => setImmediate(r));
  check('...and a badge read just now is still answered (its age is measured on the Pi\'s clock)', results.length === nr + 1);
  await msg('sensor/rfid', { ts: behind - 300, uid: '5900BF16C7' }); await new Promise((r) => setImmediate(r));
  check('...while a badge read 5 min earlier on that clock is ignored', results.length === nr + 1);
  await msg('sensor/light', { ts: clock / 1000, lux: 120 }); // clock fixed again

  // ---- statistics ----
  const day = await db.collection('daily_stats').findOne({ roomId: 'ME407', date: '2026-11-10' });
  check('daily stats: booked and occupied minutes counted', day && day.bookedMin > 0 && day.occupiedMin > 0, day && `${Math.round(day.bookedMin)} booked, ${Math.round(day.occupiedMin)} occupied`);
  check('daily stats: one no-show', day && day.noShows === 1);
  check('daily stats: avoided heating estimated after release', day && day.estHeatWhAvoided > 0, day && `${Math.round(day.estHeatWhAvoided)} Wh`);
  res = await call('GET', '/rooms/ME407/stats?days=7');
  check('GET /stats', res.status === 200 && (await res.json()).days.length === 1);

  // ---- day timeline ----
  await msg('actuator/heating/state', { on: true });
  clock = paris('2026-11-10T12:25:00');
  await msg('actuator/heating/state', { on: false });
  await msg('actuator/status/state', { state: 'free' });
  res = await call('GET', '/rooms/ME407/timeline?date=2026-11-10');
  const tl = await res.json();
  const hm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  check('timeline: day of Paris time, drawn up to now', res.status === 200 && hm(tl.from) === '00:00' && hm(tl.now) === '12:25', `${tl.from} ${tl.now}`);
  check('timeline: booked lane cut at the real end (released 10:46, no-show at its start…)', tl.lanes.booked.length >= 3 && tl.lanes.booked.some((b) => b.status === 'released'),
    tl.lanes.booked.map((b) => `${hm(b.start)}-${hm(b.end)} ${b.status}`).join(', '));
  check('timeline: occupied from motion, held for the lights-off delay', tl.lanes.occupied.length >= 1, tl.lanes.occupied.map((b) => `${hm(b.start)}-${hm(b.end)}`).join(', '));
  check('timeline: heating from what the Pi reported (12:20-12:25)', tl.lanes.heating.some((h) => hm(h.start) === '12:20' && hm(h.end) === '12:25'), JSON.stringify(tl.lanes.heating.map((h) => hm(h.start) + '-' + hm(h.end))));
  check('timeline: only on/off actuators stored (status is not)', !(await db.collection('sensor_readings').findOne({ 'meta.type': 'status_on' })));
  res = await call('GET', '/rooms/ME407/timeline?date=10-11-2026');
  check('timeline: bad date refused', res.status === 400);

  // ---- settings ----
  res = await call('PUT', '/rooms/ME407/settings', { comfortC: 20.5 });
  check('settings updated', res.status === 200 && (await res.json()).comfortC === 20.5);
  res = await call('PUT', '/rooms/ME407/settings', { comfortC: 40 });
  check('out-of-range setting refused', res.status === 400);

  // ---- timetable import ----
  const text = [
    'Time', 'Wednesday, December 16, 2026 09:30 to 12:30', 'Location', 'ME407.1', 'Description', '', '', 'ILMCA2TD02', 'MARSAN LAURENT',
    'Time', 'Wednesday, December 16, 2026 09:30 to 12:30', 'Location', 'ME407.1', 'Description', '', '', 'ILMCA2TD02', 'MARSAN LAURENT',
    'Time', 'Thursday, December 03, 2026 09:30 to 12:30', 'Location', 'ME404', 'Description', '', '', 'IMMDA2TD01', 'BERRO ALAIN'
  ].join('\n');
  res = await call('POST', '/timetable/import', text, 'text/plain');
  let imp = await res.json();
  check('timetable: 2 sessions imported, duplicate dropped', res.status === 200 && imp.added === 2, JSON.stringify(imp));
  res = await call('POST', '/timetable/import', text, 'text/plain');
  imp = await res.json();
  check('re-import adds nothing', imp.added === 0 && imp.alreadyImported === 2);
  const sessions = await db.collection('bookings').find({ source: 'timetable' }).toArray();
  check('teacher names are not stored', !JSON.stringify(sessions).includes('MARSAN') && !JSON.stringify(sessions).includes('BERRO'));
  check('room ME404 created from the timetable (no node)', (await db.collection('rooms').findOne({ _id: 'ME404' })).hasNode === false);

  clock = paris('2026-12-03T09:20:00'); await engine.tick();
  check('ME404 (no sensor) stays FREE before its class: nothing to preheat', (await db.collection('rooms').findOne({ _id: 'ME404' })).state === 'FREE');
  const sentBefore404 = sent.filter((x) => x.topic.startsWith('campus/ME404/')).length;
  await advance(22); // 09:42
  const me404 = await db.collection('bookings').findOne({ roomId: 'ME404', source: 'timetable' });
  check('ME404 (no sensor): class never judged a no-show', me404.status === 'pending', me404.status);
  check('ME404 RESERVED during its class, from the schedule', (await db.collection('rooms').findOne({ _id: 'ME404' })).state === 'RESERVED');
  check('ME404: no actuator command sent to a room without a node',
    sentBefore404 === 0 && sent.filter((x) => x.topic.startsWith('campus/ME404/')).length === 0);
  check('ME404: no usage statistics for a room without a node', !(await db.collection('daily_stats').findOne({ roomId: 'ME404' })));
  clock = paris('2026-12-03T12:31:00'); await engine.tick();
  check('ME404 FREE after its class', (await db.collection('rooms').findOne({ _id: 'ME404' })).state === 'FREE');

  clock = paris('2026-12-16T09:20:00'); await engine.tick();
  check('ME407 RESERVED before the class', (await room()).state === 'RESERVED');
  clock = paris('2026-12-16T09:33:00');
  await presence(true); await engine.tick();
  check('class checked in by presence, no badge needed', (await room()).state === 'OCCUPIED');

  // ---- ADE export: shared sessions list several rooms, folded lines, escaped commas ----
  const ade = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20270115T123000Z', 'DTEND:20270115T153000Z',
    'SUMMARY:Soutenances projet', 'LOCATION:ME403\\,ME407.1', 'DESCRIPTION:\\n\\nGROUP\\nSOME TEACHER\\n', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20270104T070000Z', 'DTEND:20270104T113000Z', 'SUMMARY:Maintenance',
    'LOCATION:AF128\\,ME404\\,ME405\\,ME407.1\\,ME41', ' 0\\,MQ113', 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const parsed = parseTimetable(ade);
  const rooms1 = parsed.filter((s) => s.start.toISOString() === '2027-01-15T12:30:00.000Z').map((s) => s.roomId);
  check('ADE: shared session booked in every listed room', rooms1.join() === 'ME403,ME407', rooms1.join());
  const rooms2 = parsed.filter((s) => s.title === 'Maintenance').map((s) => s.roomId);
  check('ADE: folded LOCATION line unfolded (ME410 across the fold)', rooms2.includes('ME410') && rooms2.includes('ME407'), rooms2.join());
  check('ADE: description (teacher names) never stored', parsed.every((s) => !JSON.stringify(s).includes('TEACHER')));

  // ---- room calendar detection ----
  const ev = (start, loc) => ['BEGIN:VEVENT', `DTSTART:${start}`, 'DTEND:' + start.replace(/T(\d\d)/, (m, h) => `T${String(+h + 1).padStart(2, '0')}`), 'SUMMARY:X', `LOCATION:${loc}`, 'END:VEVENT'];
  const roomCal = ['BEGIN:VCALENDAR', ...ev('20261201T080000Z', 'ME407.1'), ...ev('20261202T080000Z', 'ME403\\,ME407.1'), ...ev('20261203T080000Z', 'ME407.1'), 'END:VCALENDAR'].join('\r\n');
  const groupCal = ['BEGIN:VCALENDAR', ...ev('20261201T080000Z', 'ME407.1'), ...ev('20261202T080000Z', 'ME404'), ...ev('20261203T080000Z', 'MF105'), 'END:VCALENDAR'].join('\r\n');
  check('room calendar recognised (every event lists ME407)', fullCalendarRooms(roomCal).join() === 'ME407', fullCalendarRooms(roomCal).join());
  check('group timetable covers no room fully', fullCalendarRooms(groupCal).length === 0);

  // ---- class imported while already under way: kept for the schedule, never judged ----
  clock = paris('2026-12-21T10:00:00');
  const lateIcs = ['BEGIN:VCALENDAR', ...ev('20261221T083000Z', 'ME407.1'), ...ev('20261222T083000Z', 'ME407.1'), ...ev('20261223T083000Z', 'ME407.1'), 'END:VCALENDAR'].join('\r\n');
  res = await call('POST', '/timetable/import?rooms=ME4', lateIcs, 'text/calendar');
  imp = await res.json();
  check('import: running class counted as not monitored', imp.notMonitored === 1 && imp.added === 3, JSON.stringify(imp));
  check('import: ME407 marked as full calendar', imp.fullCalendar.join() === 'ME407' && Boolean((await room()).calendarFullSince));
  res = await call('POST', '/bookings', { roomId: 'ME407', userId: String(A), start: paris('2026-12-21T10:05:00').toISOString(), end: paris('2026-12-21T10:25:00').toISOString() });
  check('a booking cannot overlap an unmonitored class', res.status === 409, String(res.status));
  await advance(30); // 10:30, the class ran 09:30-10:30
  const late = await db.collection('bookings').findOne({ roomId: 'ME407', start: new Date('2026-12-21T08:30:00Z') });
  check('unmonitored class is not turned into a no-show', late.status === 'unmonitored', late.status);

  // ---- building overview ----
  res = await call('GET', '/building?prefix=ME4&date=2026-12-21');
  const bld = await res.json();
  const b407 = bld.rooms.find((r) => r.roomId === 'ME407');
  const b404 = bld.rooms.find((r) => r.roomId === 'ME404');
  check('building: week Mon 21 to Fri 25 Dec', bld.week.from === '2026-12-21' && bld.week.to === '2026-12-25');
  check('building: ME407 full calendar, 3 h of 55 open h scheduled', b407.calendar === 'full' && b407.inOpenH === 3 && b407.sharePct === 5, JSON.stringify({ c: b407.calendar, h: b407.inOpenH, p: b407.sharePct }));
  const r407 = await room();
  const expected = Math.round(r407.heatingPowerW / 1000 * 0.07 * (r407.comfortC - r407.ecoC) * 52 * 10) / 10;
  check('building: saving estimate = heater kW x 7 % x (comfort - eco) x 52 empty h', b407.estKWhAvoidable === expected, `${b407.estKWhAvoidable} vs ${expected}`);
  check('building: ME404 (partial calendar) has no share or saving', b404.calendar === 'partial' && b404.sharePct === null && b404.estKWhAvoidable === null);
  check('building: totals only over full-calendar rooms', bld.totals.fullCalendarRooms === 1 && bld.totals.openH === 55);
  check('building: bad prefix refused', (await call('GET', '/building?prefix=a;b')).status === 400);
  res = await call('GET', '/building/trend?prefix=ME4');
  const trend = (await res.json()).weeks;
  check('building trend: one entry per week from the first to the last class, the 21 Dec week included',
    res.status === 200 && trend.length >= 2 && trend.every((w, i) => !i || Date.parse(w.monday) - Date.parse(trend[i - 1].monday) === 7 * 864e5)
    && trend.some((w) => w.monday === '2026-12-21' && w.sharePct === 5), trend.map((w) => `${w.monday} ${w.sharePct}%`).join(', '));
  const ov = summarise({
    rooms: [{ _id: 'R1', calendarFullSince: new Date('2026-01-01') }], stats: [], now: new Date('2026-12-07T12:00:00Z'), defaults: { comfortC: 19, ecoC: 16, heatingPowerW: 1500 },
    date: new Date('2026-12-07T12:00:00Z'),
    bookings: [
      { roomId: 'R1', source: 'timetable', status: 'pending', start: paris('2026-12-07T09:00:00'), end: paris('2026-12-07T11:00:00') },
      { roomId: 'R1', source: 'timetable', status: 'pending', start: paris('2026-12-07T10:00:00'), end: paris('2026-12-07T12:00:00') },
      { roomId: 'R1', source: 'timetable', status: 'pending', start: paris('2026-12-07T18:00:00'), end: paris('2026-12-07T20:00:00') },
      { roomId: 'R1', source: 'user', status: 'cancelled', start: paris('2026-12-08T09:00:00'), end: paris('2026-12-08T12:00:00') }
    ]
  }).rooms[0];
  check('building: overlapping classes counted once, evening hours split, cancelled ignored',
    ov.inOpenH === 4 && ov.outsideOpenH === 1 && ov.scheduledH === 5, JSON.stringify({ i: ov.inOpenH, o: ov.outsideOpenH, s: ov.scheduledH }));

  // ---- node restart: every wanted state is sent again ----
  const before = sent.length;
  await handleMessage('campus/ME407/node/status', Buffer.from('online'));
  const resent = sent.slice(before).map((s) => s.topic.split('/')[3]);
  check('node back online: all actuator states re-sent', ['status', 'heating', 'light', 'fan'].every((n) => resent.includes(n)), resent.join(','));

  // ---- nothing is judged while nobody watches (server off or room node offline) ----
  const nodeStatus = (v) => handleMessage('campus/ME407/node/status', Buffer.from(v));
  const bk = (q) => db.collection('bookings').findOne(q);
  clock = paris('2026-12-28T08:00:00'); await engine.tick();
  await nodeStatus('offline');
  // a class that starts while the Pi is unplugged
  await db.collection('bookings').insertOne({ roomId: 'ME407', source: 'timetable', status: 'pending', userId: null, title: 'Class A', start: paris('2026-12-28T08:30:00'), end: paris('2026-12-28T10:00:00'), createdAt: clock });
  // a user booking that starts and ends while it is unplugged
  await db.collection('bookings').insertOne({ roomId: 'ME407', source: 'user', status: 'pending', userId: B, title: null, start: paris('2026-12-28T10:15:00'), end: paris('2026-12-28T10:45:00'), createdAt: clock });
  const statsBefore = (await db.collection('daily_stats').findOne({ roomId: 'ME407', date: '2026-12-28' })) || {};
  await advance(50); // 08:50, class started 20 min ago, node still offline
  check('class started with the node offline: not a no-show', (await bk({ title: 'Class A' })).status === 'pending');
  check('...room shown RESERVED (scheduled, cannot be checked)', (await room()).state === 'RESERVED');
  await nodeStatus('online');
  await presence(true); await engine.tick();
  check('node back, motion: the class checks in after all', (await bk({ title: 'Class A' })).status === 'checked_in' && (await room()).state === 'OCCUPIED');
  await presence(false);
  await nodeStatus('offline');
  clock = paris('2026-12-28T09:40:00'); await engine.tick(); // 50 min without any motion seen, node offline
  check('node offline: an occupied room is not released for "no motion"', (await bk({ title: 'Class A' })).status === 'checked_in');
  clock = paris('2026-12-28T10:50:00'); await engine.tick();
  const ub = await bk({ userId: B, start: paris('2026-12-28T10:15:00') });
  check('booking that started and ended unwatched: "unmonitored", not a no-show', ub.status === 'unmonitored', ub.status);
  const statsAfter = (await db.collection('daily_stats').findOne({ roomId: 'ME407', date: '2026-12-28' })) || {};
  check('no no-show and no usage minutes counted while unwatched',
    (statsAfter.noShows || 0) === (statsBefore.noShows || 0) && (statsAfter.bookedMin || 0) - (statsBefore.bookedMin || 0) < 6,
    JSON.stringify({ noShows: statsAfter.noShows, bookedMin: statsAfter.bookedMin }));
  // server restarted in the middle of a class: a fresh engine has never seen the node yet
  await db.collection('bookings').insertOne({ roomId: 'ME407', source: 'timetable', status: 'pending', userId: null, title: 'Class B', start: paris('2026-12-28T11:30:00'), end: paris('2026-12-28T16:00:00'), createdAt: clock });
  clock = paris('2026-12-28T11:50:00');
  const fresh = createApp(db, { room: 'ME407', now: () => clock });
  await fresh.engine.tick();
  check('server started 20 min into a class: the class is not judged a no-show', (await bk({ title: 'Class B' })).status === 'pending');
  const r2 = await fresh.engine.onBadge('ME407', await db.collection('users').findOne({ name: 'Usman' }));
  check('a badge checks the class in instead of creating a walk-in', r2.granted && /checked in/.test(r2.reason) && (await bk({ title: 'Class B' })).status === 'checked_in', r2.reason);
  const r3 = await fresh.engine.onBadge('ME407', await db.collection('users').findOne({ name: 'Zeqi' }));
  check('during a class every registered badge is welcome', r3.granted && /welcome, class/.test(r3.reason), r3.reason);
  await fresh.close();

  // ---- Wi-Fi blips: back within 2 min = watched all along ----
  clock = paris('2026-12-29T07:50:00'); await nodeStatus('online'); await engine.tick();
  await db.collection('bookings').insertOne({ roomId: 'ME407', source: 'user', status: 'pending', userId: B, title: 'Blip test', start: paris('2026-12-29T08:00:00'), end: paris('2026-12-29T09:00:00'), createdAt: clock });
  await db.collection('bookings').insertOne({ roomId: 'ME407', source: 'user', status: 'pending', userId: B, title: 'Gap test', start: paris('2026-12-29T09:10:00'), end: paris('2026-12-29T09:40:00'), createdAt: clock });
  clock = paris('2026-12-29T08:03:00'); await nodeStatus('offline');
  clock = paris('2026-12-29T08:04:00'); await nodeStatus('online');   // one-minute Wi-Fi drop after the start
  await advance(9); // 08:13
  check('a 1-min drop after the start: the booking is still judged (no-show)', (await bk({ title: 'Blip test' })).status === 'no_show', (await bk({ title: 'Blip test' })).status);
  clock = paris('2026-12-29T09:08:00'); await nodeStatus('offline');
  clock = paris('2026-12-29T09:14:00'); await nodeStatus('online');   // 6 min: a real outage across the start
  await advance(30);
  check('a 6-min outage across the start: not judged ("unmonitored")', (await bk({ title: 'Gap test' })).status === 'unmonitored', (await bk({ title: 'Gap test' })).status);

  // ---- demo database (scripts/demo-setup.js) ----
  const demo = new FakeDb();
  const srcCount = { classes: await db.collection('bookings').countDocuments({ source: 'timetable' }), people: await db.collection('bookings').countDocuments({ source: { $ne: 'timetable' } }) };
  const copied = await copyForDemo(db, demo, { room: 'ME407', today: paris('2026-12-21T09:00:00') });
  const dClasses = await demo.collection('bookings').find({}).toArray();
  check('demo copy: users and rooms copied, nothing measured', copied.users === 3 && (await demo.collection('daily_stats').countDocuments()) === 0 && (await demo.collection('events').countDocuments()) === 0);
  check('demo copy: only timetable classes, all to come again', dClasses.length > 0 && dClasses.every((b) => b.source === 'timetable' && b.status === 'pending'));
  check('demo copy: the demo room has no class on the demo day', !dClasses.some((b) => b.roomId === 'ME407' && b.start >= paris('2026-12-21T00:00:00') && b.start < paris('2026-12-22T00:00:00')) && dClasses.length < srcCount.classes);
  check('demo copy: the real database is untouched', (await db.collection('bookings').countDocuments({ source: { $ne: 'timetable' } })) === srcCount.people && srcCount.people > 0);

  // ---- measurements reset (scripts/reset-stats.js) ----
  const counts = async () => ({
    users: await db.collection('users').countDocuments(), stats: await db.collection('daily_stats').countDocuments(),
    events: await db.collection('events').countDocuments(), people: await db.collection('bookings').countDocuments({ source: { $in: ['user', 'walk_in'] } }),
    judged: await db.collection('bookings').countDocuments({ source: 'timetable', status: { $in: ['checked_in', 'no_show', 'released', 'completed'] } }),
    upcoming: await db.collection('bookings').countDocuments({ source: 'timetable', status: 'pending' })
  });
  const pre = await counts();
  const dry = await resetMeasurements(db);
  check('reset dry run changes nothing', JSON.stringify(await counts()) === JSON.stringify(pre) && dry.every((l) => l.startsWith('would')));
  await resetMeasurements(db, { apply: true });
  const post = await counts();
  check('reset: stats, log, people bookings cleared; judged classes reset', post.stats === 0 && post.events === 0 && post.people === 0 && post.judged === 0, JSON.stringify(pre));
  check('reset: users and upcoming classes kept', post.users === pre.users && post.upcoming === pre.upcoming && pre.users === 3);

  http.close();
  await close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
