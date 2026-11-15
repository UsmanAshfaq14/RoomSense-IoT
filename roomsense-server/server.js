// RoomSense server, v2: MQTT broker + room logic + MongoDB + REST API in ONE Node.js process.
// The broker lives inside this process, so it is the only component that talks to the database.
// The Raspberry Pi only ever talks MQTT to this broker.
//
// Start:   npm start                 (MongoDB must be running on this laptop)
//          npm run demo              demo mode: every room-logic "minute" lasts one second,
//                                    so a 10 min no-show grace takes 10 s in a live demo
// Config:  environment variables MONGO_URL, DB_NAME, MQTT_PORT, HTTP_PORT, HTTP_HOST, ROOM, DEMO

const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const { MongoClient, ObjectId } = require('mongodb');
const createAedes = require('aedes');
const { setupDatabase } = require('./db');
const { createEngine, DEFAULTS } = require('./engine');
const { parseTimetable, fullCalendarRooms, zoned } = require('./timetable');
const { dayTimeline } = require('./timeline');
const { summarise, weekDays } = require('./building');
const { protect, loadUsers } = require('./mqtt-auth');

const CONFIG = {
  mongoUrl: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017',
  // the demo runs on its own database (scripts/demo-setup.js prepares it), so it never mixes with real measurements
  dbName: process.env.DB_NAME || ((process.env.DEMO === '1' || process.argv.includes('--demo')) ? 'roomsense_demo' : 'roomsense'),
  mqttPort: Number(process.env.MQTT_PORT || 1883),
  httpPort: Number(process.env.HTTP_PORT || 3000),
  // The web API has no login, so by default it answers only on this laptop. The broker (with its accounts)
  // listens on the network for the Pi. HTTP_HOST=0.0.0.0 opens the dashboard to other devices (phone in a demo).
  httpHost: process.env.HTTP_HOST || '127.0.0.1',
  room: process.env.ROOM || 'ME407',
  demo: process.env.DEMO === '1' || process.argv.includes('--demo'),
  mqttUsersFile: process.env.MQTT_USERS_FILE || path.join(__dirname, 'mqtt-users.json'),
  // the built dashboard (npm run build in the dashboard folder), served by this process on the same port
  dashboardDir: process.env.DASHBOARD_DIR || ['dashboard', 'roomsense-dashboard']
    .map((d) => path.join(__dirname, '..', d, 'dist', 'roomsense-dashboard', 'browser'))
    .find((d) => fs.existsSync(path.join(d, 'index.html')))
};

// MongoDB unreachable (stopped, network): the driver raises these, and reconnects by itself once it is back.
// One log line when MongoDB goes away and one when it is back (with what was lost), not a line per message.
const outage = { since: null, dropped: 0, refused: 0 };
function dbDown(what) {
  if (outage.since) return;
  outage.since = Date.now();
  console.warn(`MongoDB unreachable (${what}): readings dropped, badges refused, web requests answered 503; reconnecting by itself`);
}
function dbUp() {
  if (!outage.since) return;
  console.log(`MongoDB back after ${Math.round((Date.now() - outage.since) / 1000)} s: ${outage.dropped} message(s) dropped, ${outage.refused} web request(s) refused meanwhile`);
  outage.since = null; outage.dropped = 0; outage.refused = 0;
}
const isDbDown = (err) => Boolean(err) && /^Mongo(ServerSelection|Network|NotConnected|Topology)/.test(err.name || '');

// ---------- validation helpers ----------
class BadInput extends Error {}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function num(v, min, max, name) {
  if (!isNum(v) || v < min || v > max) throw new BadInput(`${name} must be a number between ${min} and ${max}`);
  return v;
}
function bool(v, name) {
  if (typeof v !== 'boolean') throw new BadInput(`${name} must be true or false`);
  return v;
}
function oneOf(v, options, name) {
  if (!options.includes(v)) throw new BadInput(`${name} must be one of ${options.join(', ')}`);
  return v;
}
function date(v, name) {
  const d = new Date(v);
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw new BadInput(`${name} must be an ISO date, e.g. 2026-11-10T14:00:00+01:00`);
  return d;
}
function objectId(v, name) {
  if (typeof v !== 'string' || !ObjectId.isValid(v)) throw new BadInput(`${name} is not a valid id`);
  return new ObjectId(v);
}
// The Pi sends epoch seconds, but its clock is not reliable: the Pi 3 has no clock battery, so after a power cut
// it runs minutes or hours behind until it reaches a time server (seen on 12 November: 9 min behind). Readings are
// sent as soon as they are taken, so a timestamp more than 60 s off means the Pi's clock is wrong: use ours.
const CLOCK_TOLERANCE_MS = 60 * 1000;
function toDate(ts, nowMs = Date.now()) {
  if (!isNum(ts) || Math.abs(ts * 1000 - nowMs) > CLOCK_TOLERANCE_MS) return new Date(nowMs);
  return new Date(ts * 1000);
}
const hashUid = (uid) => crypto.createHash('sha256').update(String(uid).trim().toUpperCase()).digest('hex');

// Commands the dashboard may send to each actuator, checked before they reach the Pi.
const ACTUATORS = {
  status: (b) => ({ state: oneOf(b.state, ['free', 'reserved', 'occupied', 'offline'], 'state') }),
  heating: (b) => ({ on: bool(b.on, 'on') }),
  light: (b) => ({ on: bool(b.on, 'on'), level: b.level === undefined ? 1 : num(b.level, 0, 1, 'level') }),
  fan: (b) => ({ on: bool(b.on, 'on'), speed: b.speed === undefined ? 0.9 : num(b.speed, 0, 1, 'speed') })
};

// Room settings the dashboard may change, with their allowed ranges.
const SETTINGS = {
  comfortC: [10, 26], ecoC: [5, 22], luxThreshold: [0, 5000], preheatMin: [0, 120], graceMin: [1, 60],
  presenceTimeoutMin: [1, 120], releaseTimeoutMin: [1, 240], walkInMin: [10, 240], overrideMin: [1, 240],
  humidityMax: [30, 95], gasMinOhms: [0, 1e6], lightPowerW: [0, 10000], heatingPowerW: [0, 20000]
};

// Sensor payloads from the Pi -> rows for the time-series collection.
const SENSORS = {
  presence: (d) => [['presence', bool(d.presence, 'presence') ? 1 : 0]],
  climate: (d) => {
    const rows = [
      ['temperature', num(d.celsius, -40, 85, 'celsius')],
      ['humidity', num(d.humidity, 0, 100, 'humidity')],
      ['pressure', num(d.hPa, 300, 1100, 'hPa')]
    ];
    if (d.gasOhms !== null && d.gasOhms !== undefined) rows.push(['gas', num(d.gasOhms, 0, 1e9, 'gasOhms')]);
    return rows;
  },
  light: (d) => [['light', num(d.lux, 0, 200000, 'lux')]]
};

const TOPIC = /^campus\/([A-Za-z0-9_-]+)\/(.+)$/;
const SERVER_ONLY = /^campus\/[^/]+\/(actuator\/[^/]+\/set|rfid\/result)$/;

function newRoom(id, hasNode) {
  return {
    name: `Room ${id}`, building: 'UT1 Capitole', state: 'FREE', nodeStatus: 'offline', hasNode,
    comfortC: DEFAULTS.comfortC, ecoC: DEFAULTS.ecoC, luxThreshold: DEFAULTS.luxThreshold,
    lightPowerW: DEFAULTS.lightPowerW, heatingPowerW: DEFAULTS.heatingPowerW, actuators: {}
  };
}

function createApp(db, cfg = CONFIG) {
  const now = cfg.now || (() => new Date());
  const aedes = createAedes();
  const readings = db.collection('sensor_readings');
  const events = db.collection('events');
  const rooms = db.collection('rooms');
  const users = db.collection('users');
  const bookings = db.collection('bookings');
  const stats = db.collection('daily_stats');
  const sseClients = new Set();
  let lastUnknownUid = null;   // kept in memory only, to help register a new badge

  const broadcast = (type, data) => {
    const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(line);
  };
  const logEvent = (roomId, type, source, details = {}, userId = null) =>
    events.insertOne({ ts: now(), roomId, type, source, userId, details });

  const publish = (topic, payload, { qos = 1, retain = false } = {}) =>
    new Promise((resolve, reject) =>
      aedes.publish({ cmd: 'publish', topic, payload: Buffer.from(JSON.stringify(payload)), qos, retain, dup: false },
        (err) => (err ? reject(err) : resolve())));

  const engine = createEngine({ db, publish, logEvent, broadcast, now, demo: cfg.demo });

  // Logins and per-room topic rights (mqtt-auth.js); with no account configured the broker stays open.
  const access = protect(aedes, cfg.mqttUsers || {});
  // Only the server may send commands; a client trying to publish one is refused.
  // A node account may only publish under its own room, so one Pi cannot pose as another room.
  aedes.authorizePublish = (client, packet, callback) => {
    if (client && SERVER_ONLY.test(packet.topic)) return callback(new Error(`clients may not publish to ${packet.topic}`));
    if (!access.mayPublish(client, packet.topic)) {
      console.warn(`MQTT publish refused: ${client.account ? client.account.name : client.id} -> ${packet.topic}`);
      return callback(new Error(`not allowed to publish to ${packet.topic}`));
    }
    callback(null);
  };

  const clockOffset = new Map(); // roomId -> server time minus the Pi's time, from its latest live reading
  async function handleRfid(roomId, data) {
    if (typeof data.uid !== 'string' || !/^[0-9A-Fa-f]{10}$/.test(data.uid)) throw new BadInput('uid must be 10 hex characters');
    // A badge read long ago (queued while the link was down) must not check anyone in now. Its age is measured
    // against the Pi's own clock offset, learnt from its live readings, so a Pi running minutes behind after a
    // power cut does not get every badge refused. No reading yet since the server started: cannot tell, accept.
    const offset = clockOffset.get(roomId);
    if (isNum(data.ts) && offset !== undefined && now().getTime() - data.ts * 1000 - offset > 60 * 1000) {
      await logEvent(roomId, 'bad_message', 'node', { topic: 'sensor/rfid', error: 'badge read more than 60 s ago, ignored' });
      return;
    }
    const user = await users.findOne({ rfidUidHash: hashUid(data.uid) });
    const { granted, reason } = await engine.onBadge(roomId, user);
    if (!user) lastUnknownUid = { uid: data.uid.toUpperCase(), roomId, at: now() };
    await publish(`campus/${roomId}/rfid/result`, { granted, reason });
    await logEvent(roomId, granted ? 'access_granted' : 'access_denied', 'node', { reason }, user ? user._id : null);
    broadcast('access', { roomId, granted, reason, user: user ? user.name : null, ts: now() });
  }

  async function handleMessage(topic, raw) {
    const m = TOPIC.exec(topic);
    if (!m) return;
    const [, roomId, sub] = m;
    const text = raw.toString();

    if (sub === 'node/status') {
      const status = oneOf(text, ['online', 'offline'], 'node status');
      // a node reporting in a timetable-only room (a second Pi in ME404, say) makes it a monitored room
      await rooms.updateOne({ _id: roomId }, { $set: { nodeStatus: status, lastSeen: now(), hasNode: true } });
      await logEvent(roomId, status === 'online' ? 'node_online' : 'node_offline', 'node');
      broadcast('node', { roomId, status, ts: now() });
      await engine.onNodeStatus(roomId, status);
      return;
    }

    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null) throw new BadInput('payload must be a JSON object');

    if (sub.startsWith('sensor/')) {
      const kind = sub.slice('sensor/'.length);
      await rooms.updateOne({ _id: roomId }, { $set: { lastSeen: now() } });
      if (kind === 'rfid') return handleRfid(roomId, data);
      const toRows = SENSORS[kind];
      if (!toRows) throw new BadInput(`unknown sensor ${kind}`);
      if (isNum(data.ts)) clockOffset.set(roomId, now().getTime() - data.ts * 1000);
      const ts = toDate(data.ts, now().getTime());
      const rows = toRows(data).map(([type, value]) => ({ ts, meta: { roomId, type }, value }));
      await readings.insertMany(rows);
      // BME680 warm-up: gas is stored (the curve is useful) but kept out of the air rule until the node says it is
      // ready, otherwise every node start raises a false "bad air" alert. Older nodes send no flag: treated as ready.
      let pairs = rows.map((r) => [r.meta.type, r.value]);
      const extra = {};
      if (kind === 'climate' && data.gasReady !== undefined) {
        extra.gasReady = bool(data.gasReady, 'gasReady');
        await rooms.updateOne({ _id: roomId }, { $set: { gasReady: extra.gasReady } });
        if (!extra.gasReady) pairs = pairs.filter(([type]) => type !== 'gas');
      }
      broadcast('reading', { roomId, ts, values: Object.fromEntries(rows.map((r) => [r.meta.type, r.value])), ...extra });
      await engine.onReadings(roomId, pairs);
      return;
    }

    const state = /^actuator\/([a-z]+)\/state$/.exec(sub);
    if (state) {
      await rooms.updateOne({ _id: roomId }, { $set: { [`actuators.${state[1]}`]: { ...data, ts: now() } } });
      // what the Pi reports it actually did is kept as a 0/1 series (heating_on, light_on, fan_on) for the day timeline
      if (['heating', 'light', 'fan'].includes(state[1]) && typeof data.on === 'boolean') {
        await readings.insertOne({ ts: now(), meta: { roomId, type: `${state[1]}_on` }, value: data.on ? 1 : 0 });
      }
      broadcast('actuator', { roomId, actuator: state[1], ...data });
    }
  }

  aedes.on('publish', (packet, client) => {
    if (!client) return; // our own publishes
    handleMessage(packet.topic, packet.payload).catch(async (err) => {
      const m = TOPIC.exec(packet.topic);
      if (isDbDown(err)) {
        // MongoDB unreachable: nothing can be stored. A badge still gets an answer, so the reader is not left silent.
        outage.dropped += 1; dbDown(`while handling ${packet.topic}`);
        if (m && m[2] === 'sensor/rfid') await publish(`campus/${m[1]}/rfid/result`, { granted: false, reason: 'system temporarily unavailable' }).catch(() => {});
        return;
      }
      console.warn(`rejected ${packet.topic}: ${err.message}`);
      if (m) await logEvent(m[1], 'bad_message', 'node', { topic: packet.topic, error: err.message }).catch(() => {});
    });
  });
  aedes.on('client', (c) => console.log(`MQTT connected:    ${c.id}`));
  aedes.on('clientDisconnect', (c) => console.log(`MQTT disconnected: ${c.id}`));

  // ---------- REST API ----------
  const app = express();
  // gzip every response worth it (JSON, JS, CSS), except the live stream, which must not be buffered
  app.use(compression({ filter: (req, res) => req.path !== '/api/stream' && compression.filter(req, res) }));
  app.use(express.json());
  app.use(express.text({ type: ['text/plain', 'text/calendar'], limit: '5mb' }));
  app.use((req, res, next) => {          // allow the Angular dev server (ng serve) to call the API
    res.set('Access-Control-Allow-Origin', 'http://localhost:4200');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
  const findRoom = async (id, res) => {
    const room = await rooms.findOne({ _id: id });
    if (!room) res.status(404).json({ error: `room ${id} not found` });
    return room;
  };
  const userNames = async () => new Map((await users.find({}).toArray()).map((u) => [String(u._id), u.name]));
  const withNames = (list, names) => list.map((b) => ({ ...b, userName: b.userId ? names.get(String(b.userId)) || null : null }));

  // health says whether MongoDB answers too, so a database outage is visible at a glance
  app.get('/api/health', async (req, res) => {
    let database = 'up';
    try {
      await Promise.race([rooms.findOne({}), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 2000))]);
    } catch (err) { database = 'down'; }
    res.status(database === 'up' ? 200 : 503).json({ ok: database === 'up', database, mqttClients: aedes.connectedClients, demo: Boolean(cfg.demo) });
  });

  app.get('/api/rooms', wrap(async (req, res) => {
    const list = await rooms.find({}).toArray();
    res.json(list.map((r) => ({ ...r, airAlert: engine.live(r._id).airAlert })));
  }));

  app.get('/api/rooms/:id', wrap(async (req, res) => {
    const room = await findRoom(req.params.id, res);
    if (!room) return;
    const types = ['presence', 'temperature', 'humidity', 'pressure', 'gas', 'light'];
    const latest = {};
    await Promise.all(types.map(async (type) => {
      const doc = await readings.find({ 'meta.roomId': room._id, 'meta.type': type }).sort({ ts: -1 }).limit(1).toArray();
      if (doc.length) latest[type] = { value: doc[0].value, ts: doc[0].ts };
    }));
    const names = await userNames();
    const current = await bookings.findOne({ roomId: room._id, status: 'checked_in' });
    const next = await bookings.find({ roomId: room._id, status: 'pending', end: { $gt: now() } }).sort({ start: 1 }).limit(1).toArray();
    const live = engine.live(room._id);
    res.json({
      ...room, latest, airAlert: live.airAlert, overrides: live.overrides, settingsDefaults: DEFAULTS,
      clock: engine.clock(room, current, next[0]),
      currentBooking: current ? withNames([current], names)[0] : null,
      nextBooking: next.length ? withNames(next, names)[0] : null
    });
  }));

  app.put('/api/rooms/:id/settings', wrap(async (req, res) => {
    const room = await findRoom(req.params.id, res);
    if (!room) return;
    const body = req.body || {};
    const update = {};
    for (const [key, [min, max]] of Object.entries(SETTINGS)) {
      if (body[key] !== undefined) update[key] = num(body[key], min, max, key);
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new BadInput('name must be text');
      update.name = body.name.trim();
    }
    if (!Object.keys(update).length) throw new BadInput(`nothing to change; allowed: name, ${Object.keys(SETTINGS).join(', ')}`);
    await rooms.updateOne({ _id: room._id }, { $set: update });
    await engine.evaluate(room._id);
    res.json(await rooms.findOne({ _id: room._id }));
  }));

  app.get('/api/rooms/:id/readings', wrap(async (req, res) => {
    const type = String(req.query.type || 'temperature');
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
    const since = new Date(now().getTime() - hours * 3600 * 1000);
    const rows = await readings
      .find({ 'meta.roomId': req.params.id, 'meta.type': type, ts: { $gte: since } }, { projection: { _id: 0, ts: 1, value: 1 } })
      .sort({ ts: 1 }).limit(5000).toArray();
    res.json(rows);
  }));

  // One day of the room on one time axis (timeline.js): scheduled, booked, occupied, heating, lights, fan, node offline.
  app.get('/api/rooms/:id/timeline', wrap(async (req, res) => {
    const room = await findRoom(req.params.id, res);
    if (!room) return;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(now());
    const day = String(req.query.date || today);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m) throw new BadInput('date must be YYYY-MM-DD');
    const from = zoned(+m[1], +m[2] - 1, +m[3], 0, 0);
    const to = zoned(+m[1], +m[2] - 1, +m[3] + 1, 0, 0);
    const until = new Date(Math.min(to.getTime(), Math.max(from.getTime(), now().getTime())));
    const series = (type) => readings.find({ 'meta.roomId': room._id, 'meta.type': type, ts: { $gte: from, $lt: until } }, { projection: { _id: 0, ts: 1, value: 1 } }).sort({ ts: 1 }).limit(5000).toArray();
    const lastBefore = async (type) => {
      const r = await readings.find({ 'meta.roomId': room._id, 'meta.type': type, ts: { $lt: from } }).sort({ ts: -1 }).limit(1).toArray();
      return Boolean(r.length && r[0].value);
    };
    const types = ['heating_on', 'light_on', 'fan_on'];
    const [list, presence, names, nodeEvents, lastNode, ...acts] = await Promise.all([
      bookings.find({ roomId: room._id, status: { $ne: 'cancelled' }, start: { $lt: to }, end: { $gt: from } }).sort({ start: 1 }).toArray(),
      series('presence'), userNames(),
      events.find({ roomId: room._id, type: { $in: ['node_online', 'node_offline'] }, ts: { $gte: from, $lt: until } }).sort({ ts: 1 }).toArray(),
      events.find({ roomId: room._id, type: { $in: ['node_online', 'node_offline'] }, ts: { $lt: from } }).sort({ ts: -1 }).limit(1).toArray(),
      ...types.map(series)
    ]);
    const before = { presence: await lastBefore('presence'), nodeOnline: lastNode.length ? lastNode[0].type === 'node_online' : room.nodeStatus === 'online' };
    for (const t of types) before[t] = await lastBefore(t);
    res.json({
      roomId: room._id, date: day, hasNode: room.hasNode !== false, presenceHoldMin: room.presenceTimeoutMin ?? DEFAULTS.presenceTimeoutMin,
      ...dayTimeline({
        bookings: withNames(list, names), presence, actuators: Object.fromEntries(types.map((t, i) => [t, acts[i]])), nodeEvents, before,
        from: from.getTime(), to: to.getTime(), until: until.getTime(), holdMs: (room.presenceTimeoutMin ?? DEFAULTS.presenceTimeoutMin) * engine.unit
      })
    });
  }));

  app.get('/api/rooms/:id/stats', wrap(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
    const rows = await stats.find({ roomId: req.params.id }).sort({ date: -1 }).limit(days).toArray();
    res.json({
      note: 'Energy figures are estimates: avoided lighting = booked minutes with lights off x lightPowerW; ' +
        'avoided heating = time a no-show or released room spent at eco x heatingPowerW x 7 % per degree lowered.',
      days: rows
    });
  }));

  // The web-triggered actuators: dashboard -> this API -> broker -> Pi.
  // {"mode":"auto"} hands the actuator back to the automatic rules.
  app.post('/api/rooms/:id/actuators/:name', wrap(async (req, res) => {
    const build = ACTUATORS[req.params.name];
    if (!build) return res.status(404).json({ error: `unknown actuator ${req.params.name}` });
    const room = await findRoom(req.params.id, res);
    if (!room) return;
    const body = req.body || {};
    if (body.mode === 'auto') {
      engine.setOverride(room._id, req.params.name, null);
      await logEvent(room._id, 'override', 'web', { actuator: req.params.name, mode: 'auto' });
      await engine.evaluate(room._id);
      return res.status(202).json({ mode: 'auto' });
    }
    const command = build(body);
    await publish(`campus/${room._id}/actuator/${req.params.name}/set`, command, { qos: 1, retain: true });
    const until = await engine.setOverride(room._id, req.params.name, command);
    await logEvent(room._id, 'override', 'web', { actuator: req.params.name, command });
    res.status(202).json({ sent: command, overrideUntil: until, nodeStatus: room.nodeStatus });
  }));

  // ---------- building overview: one teaching week for every room of a floor ----------
  // GET /api/building/trend?prefix=ME4: the same weekly figures for every week of the imported timetable (max 20),
  // so the term shape is visible at once: busy teaching weeks, then exams and holidays.
  app.get('/api/building/trend', wrap(async (req, res) => {
    const prefix = String(req.query.prefix || '').toUpperCase().trim();
    if (prefix && !/^[A-Z0-9]{1,8}$/.test(prefix)) throw new BadInput('prefix must be letters and digits, e.g. ME4');
    const list = (await rooms.find({}).toArray()).filter((r) => r._id.startsWith(prefix)).sort((a, b) => a._id.localeCompare(b._id));
    const ids = list.map((r) => r._id);
    const all = await bookings.find({ roomId: { $in: ids }, status: { $ne: 'cancelled' } }).sort({ start: 1 }).toArray();
    const classes = all.filter((b) => b.source === 'timetable');
    if (!classes.length) return res.json({ prefix, weeks: [] });
    const first = weekDays(classes[0].start)[0];
    const last = classes[classes.length - 1].start;
    const weeks = [];
    for (let i = 0; i < 20; i += 1) {
      const date = new Date(Date.UTC(+first.date.slice(0, 4), +first.date.slice(5, 7) - 1, +first.date.slice(8, 10) + 7 * i, 12));
      const days = weekDays(date);
      if (days[0].dayStart > last) break;
      const week = all.filter((b) => b.start < days[4].dayEnd && b.end > days[0].dayStart);
      const sum = summarise({ rooms: list, bookings: week, stats: [], date, now: now(), defaults: DEFAULTS });
      weeks.push({ monday: days[0].date, current: now() >= days[0].dayStart && now() < days[4].dayEnd, ...sum.totals });
    }
    res.json({ prefix, weeks });
  }));

  // GET /api/building?prefix=ME4&date=2026-11-16  (date = any day of the week; default this week)
  app.get('/api/building', wrap(async (req, res) => {
    const prefix = String(req.query.prefix || '').toUpperCase().trim();
    if (prefix && !/^[A-Z0-9]{1,8}$/.test(prefix)) throw new BadInput('prefix must be letters and digits, e.g. ME4');
    let date = now();
    if (req.query.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date))) throw new BadInput('date must be YYYY-MM-DD');
      date = new Date(`${req.query.date}T12:00:00Z`);
      if (Number.isNaN(date.getTime())) throw new BadInput('date must be YYYY-MM-DD');
    }
    const days = weekDays(date);
    const list = (await rooms.find({}).toArray()).filter((r) => r._id.startsWith(prefix)).sort((a, b) => a._id.localeCompare(b._id));
    const ids = list.map((r) => r._id);
    const week = await bookings.find({ roomId: { $in: ids }, start: { $lt: days[4].dayEnd }, end: { $gt: days[0].dayStart } }).toArray();
    const weekStats = await stats.find({ roomId: { $in: ids }, date: { $gte: days[0].date, $lte: days[4].date } }).toArray();
    res.json({ prefix, ...summarise({ rooms: list, bookings: week, stats: weekStats, date, now: now(), defaults: DEFAULTS }) });
  }));

  // ---------- bookings ----------
  app.get('/api/bookings', wrap(async (req, res) => {
    const from = req.query.from ? date(String(req.query.from), 'from') : new Date(now().getTime() - 24 * 3600 * 1000);
    const to = req.query.to ? date(String(req.query.to), 'to') : new Date(now().getTime() + 14 * 24 * 3600 * 1000);
    const filter = { end: { $gt: from }, start: { $lt: to } };
    if (req.query.roomId) filter.roomId = String(req.query.roomId);
    const list = await bookings.find(filter).sort({ start: 1 }).limit(500).toArray();
    res.json(withNames(list, await userNames()));
  }));

  app.post('/api/bookings', wrap(async (req, res) => {
    const body = req.body || {};
    const room = await findRoom(String(body.roomId || ''), res);
    if (!room) return;
    // without a node nobody can badge in and no-shows cannot be seen: such rooms follow the university timetable only
    if (room.hasNode === false) throw new BadInput('this room has no RoomSense node yet: it follows the university timetable only');
    const userId = objectId(body.userId, 'userId');
    const user = await users.findOne({ _id: userId });
    if (!user) throw new BadInput('user not found');
    const start = date(body.start, 'start');
    const end = date(body.end, 'end');
    if (end <= start) throw new BadInput('end must be after start');
    if (end - start > 4 * 3600 * 1000) throw new BadInput('a booking lasts at most 4 hours');
    if (end <= now()) throw new BadInput('this time is already over');
    const clash = await bookings.findOne({ roomId: room._id, status: { $in: ['pending', 'checked_in', 'unmonitored'] }, start: { $lt: end }, end: { $gt: start } });
    if (clash) return res.status(409).json({ error: 'the room is already booked at that time', clash });
    const doc = {
      roomId: room._id, userId, start, end, status: 'pending', source: 'user',
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 60) : null, createdAt: now()
    };
    const { insertedId } = await bookings.insertOne(doc);
    await engine.evaluate(room._id);
    broadcast('booking', { roomId: room._id, bookingId: insertedId, status: 'pending' });
    res.status(201).json({ _id: insertedId, ...doc, userName: user.name });
  }));

  app.delete('/api/bookings/:id', wrap(async (req, res) => {
    const id = objectId(req.params.id, 'booking id');
    const b = await bookings.findOne({ _id: id });
    if (!b) return res.status(404).json({ error: 'booking not found' });
    if (b.status !== 'pending') return res.status(409).json({ error: `a ${b.status} booking cannot be cancelled` });
    await bookings.updateOne({ _id: id }, { $set: { status: 'cancelled', endedAt: now(), endReason: 'cancelled on the dashboard' } });
    await engine.evaluate(b.roomId);
    broadcast('booking', { roomId: b.roomId, bookingId: id, status: 'cancelled' });
    res.json({ cancelled: true });
  }));

  // ---------- timetable import ----------
  // Body: the .ics file or the pasted invitation text (Content-Type text/calendar or text/plain), or JSON {"text": "..."}.
  app.post('/api/timetable/import', wrap(async (req, res) => {
    const text = typeof req.body === 'string' ? req.body : (req.body && req.body.text);
    if (typeof text !== 'string' || !text.trim()) throw new BadInput('send the timetable as text: an .ics file or the invitation text');
    const all = parseTimetable(text);
    if (!all.length) throw new BadInput('no sessions found: expected an .ics file or Outlook invitation text with Time / Location lines');
    // ?rooms=ME4,ME3 keeps only rooms starting with one of these prefixes, so a whole-campus export
    // (a group timetable, or a maintenance slot listing 20 rooms) does not create rooms nobody monitors
    const prefixes = String(req.query.rooms || '').toUpperCase().split(',').map((p) => p.trim()).filter(Boolean);
    const sessions = prefixes.length ? all.filter((s) => prefixes.some((p) => s.roomId.startsWith(p))) : all;
    const t = now();
    const perRoom = {};
    let added = 0; let known = 0; let past = 0;
    for (const s of sessions) {
      // a class already under way (or over) when imported was not watched from its start: it is kept for the
      // schedule but marked unmonitored, so it is never judged a no-show or counted as used
      const late = s.start <= t;
      if (late) past += 1;
      await rooms.updateOne({ _id: s.roomId }, { $setOnInsert: newRoom(s.roomId, false) }, { upsert: true });
      const r = await bookings.updateOne(
        { roomId: s.roomId, start: s.start, end: s.end, source: 'timetable' },
        { $setOnInsert: { status: late ? 'unmonitored' : 'pending', userId: null, title: s.title, location: s.location, createdAt: t } },
        { upsert: true }
      );
      if (r.upsertedCount) added += 1; else known += 1;
      perRoom[s.roomId] = (perRoom[s.roomId] || 0) + 1;
    }
    const fullRooms = fullCalendarRooms(text).filter((id) => !prefixes.length || prefixes.some((p) => id.startsWith(p)));
    for (const id of fullRooms) {
      await rooms.updateOne({ _id: id }, { $setOnInsert: newRoom(id, false) }, { upsert: true });
      await rooms.updateOne({ _id: id, calendarFullSince: { $exists: false } }, { $set: { calendarFullSince: t } });
    }
    await logEvent(cfg.room, 'timetable_import', 'web', { added, known, past, rooms: perRoom, fullCalendar: fullRooms });
    for (const roomId of Object.keys(perRoom)) await engine.evaluate(roomId);
    res.json({ sessionsFound: all.length, outsideFilter: all.length - sessions.length, fullCalendar: fullRooms, added, alreadyImported: known, notMonitored: past, rooms: perRoom });
  }));

  // ---------- events, users, live stream ----------
  app.get('/api/events', wrap(async (req, res) => {
    const filter = req.query.roomId ? { roomId: String(req.query.roomId) } : {};
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const list = await events.find(filter).sort({ ts: -1 }).limit(limit).toArray();
    res.json(withNames(list, await userNames()));
  }));

  app.get('/api/users', wrap(async (req, res) =>
    res.json(await users.find({}, { projection: { rfidUidHash: 0 } }).toArray())));

  app.post('/api/users', wrap(async (req, res) => {
    const { name, email, role = 'student', rfidUid } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) throw new BadInput('name is required');
    if (typeof rfidUid !== 'string' || !/^[0-9A-Fa-f]{10}$/.test(rfidUid)) throw new BadInput('rfidUid must be 10 hex characters');
    oneOf(role, ['student', 'admin'], 'role');
    const doc = { name: name.trim(), role, rfidUidHash: hashUid(rfidUid), createdAt: now() };
    if (email) doc.email = String(email).trim().toLowerCase();
    try {
      const { insertedId } = await users.insertOne(doc);
      if (lastUnknownUid && lastUnknownUid.uid === rfidUid.toUpperCase()) lastUnknownUid = null;
      res.status(201).json({ _id: insertedId, name: doc.name, role, email: doc.email });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'this badge or email is already registered' });
      throw err;
    }
  }));

  // The last badge that was refused, so it can be registered from the dashboard without retyping it.
  app.get('/api/rfid/last-unknown', (req, res) => res.json(lastUnknownUid));

  // Live updates for the dashboard (server-sent events: no extra library on either side).
  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('event: hello\ndata: {}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ---------- the dashboard itself (production build), same origin as the API ----------
  // Angular puts a content hash in every file name (main-FDMJ6WZV.js): those files never change, so the
  // browser may keep them a year; index.html is always revalidated so a new build is picked up at once.
  const dashboardDir = cfg.dashboardDir;
  if (dashboardDir) {
    const HASHED = /-[A-Z0-9]{8}\.(js|css)$/;
    app.use(express.static(dashboardDir, {
      index: false,
      setHeaders: (res, file) => res.set('Cache-Control', HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache')
    }));
    app.get(/^\/(?!api\/).*/, (req, res) => {        // client-side routes (/rooms/ME407, /building ...) -> the app
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(dashboardDir, 'index.html'));
    });
  }

  app.use((err, req, res, next) => {
    if (err instanceof BadInput || err.type === 'entity.parse.failed') return res.status(400).json({ error: err.message });
    if (isDbDown(err)) {
      outage.refused += 1; dbDown(`${req.method} ${req.path}`);
      return res.status(503).json({ error: 'database unavailable: the server keeps running and reconnects by itself' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  const mqttServer = net.createServer(aedes.handle);
  return {
    aedes, app, mqttServer, engine, handleMessage, mqttAuth: access.enabled,
    close: () => new Promise((r) => { mqttServer.close(); aedes.close(r); })
  };
}

async function main() {
  // 2 s: during an outage a badge is refused within ~2 s instead of keeping the person waiting 5 s
  const client = new MongoClient(CONFIG.mongoUrl, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
  } catch (err) {
    console.error(`Cannot reach MongoDB at ${CONFIG.mongoUrl}. Is the MongoDB service running?\n${err.message}`);
    process.exit(1);
  }
  const db = client.db(CONFIG.dbName);
  await setupDatabase(db, CONFIG.room);
  let mqttUsers;
  try {
    mqttUsers = loadUsers(CONFIG.mqttUsersFile);
  } catch (err) {
    console.error(`Cannot read the MQTT accounts: ${err.message}`);
    process.exit(1);
  }
  const { app, mqttServer, engine, mqttAuth } = createApp(db, { ...CONFIG, mqttUsers });
  if (mqttAuth) console.log(`MQTT login required (${Object.keys(mqttUsers).length} account(s) in ${CONFIG.mqttUsersFile})`);
  else console.warn('WARNING: MQTT login is OFF, any device on the network can publish. Create an account: node scripts/mqtt-user.js add node-ME407 --room ME407');
  mqttServer.listen(CONFIG.mqttPort, '0.0.0.0', () => console.log(`MQTT broker on port ${CONFIG.mqttPort}`));
  app.listen(CONFIG.httpPort, CONFIG.httpHost, () => {
    console.log(`API on http://localhost:${CONFIG.httpPort}/api/health`);
    console.log(CONFIG.httpHost === '127.0.0.1'
      ? 'Web API and dashboard: this laptop only (set HTTP_HOST=0.0.0.0 to open them to the network; they have no login)'
      : `Web API and dashboard open on ${CONFIG.httpHost}: anyone on the network can use them (no login)`);
    if (CONFIG.dashboardDir) console.log(`Dashboard on http://localhost:${CONFIG.httpPort}  (build in ${CONFIG.dashboardDir})`);
    else console.log('Dashboard not built: run "npm run build" in the dashboard folder, or use "npm start" there (port 4200)');
  });
  if (CONFIG.demo) console.log('DEMO mode: every room-logic minute lasts one second');
  setInterval(() => engine.tick().then(dbUp, (err) => (isDbDown(err) ? dbDown('room logic') : console.error('room logic:', err.message))),
    CONFIG.demo ? 1000 : 5000);
}

if (require.main === module) main();

module.exports = { createApp, hashUid, ACTUATORS, SENSORS, SETTINGS };
