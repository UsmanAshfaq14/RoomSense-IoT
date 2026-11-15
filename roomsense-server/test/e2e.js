// End-to-end test: server (in-memory DB) + real MQTT broker + the real Pi node program with mock GPIO pins.
// Run: npm test   (needs python3 with paho-mqtt and gpiozero; set NODE_SCRIPT to roomsense_node.py's path)
const path = require('path');
const { spawn } = require('child_process');
const mqtt = require('mqtt');
const { createApp, hashUid } = require('../server');
const { FakeDb } = require('./fake-db');
const { hashPassword } = require('../mqtt-auth');

const MQTT_PORT = 18830;
const HTTP_PORT = 13000;
const ROOM = 'ME407';
const fs = require('fs');
// the Pi program: NODE_SCRIPT, else the node folder next to this one (named node/ in the final package)
const NODE_SCRIPT = process.env.NODE_SCRIPT || ['node', 'roomsense'].map((d) => path.join(__dirname, '..', '..', d, 'roomsense_node.py')).find((p) => fs.existsSync(p))
  || path.join(__dirname, '..', '..', 'node', 'roomsense_node.py');
const API = `http://127.0.0.1:${HTTP_PORT}/api`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
  return false;
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  const db = new FakeDb();
  await db.collection('users').createIndex({ rfidUidHash: 1 }, { unique: true });
  await db.collection('rooms').insertOne({ _id: ROOM, name: 'Study room', state: 'FREE', nodeStatus: 'offline', comfortC: 19, ecoC: 16, luxThreshold: 150, actuators: {} });
  // MQTT login on: one node account for the Pi, one admin account for the test client
  const NODE_PW = 'node-secret-1'; const SIM_PW = 'sim-secret-2';
  const mqttUsers = {
    'node-ME407': { role: 'node', room: ROOM, ...hashPassword(NODE_PW) },
    sim: { role: 'admin', ...hashPassword(SIM_PW) }
  };
  const { app, mqttServer, close, mqttAuth } = createApp(db, { room: ROOM, mqttUsers });
  check('broker requires a login', mqttAuth === true);
  await new Promise((r) => mqttServer.listen(MQTT_PORT, r));
  const http = app.listen(HTTP_PORT);

  // 1. the real node program, mock pins
  const node = spawn('python3', [NODE_SCRIPT, '--broker', '127.0.0.1', '--port', String(MQTT_PORT), '--room', ROOM, '--debug'], {
    env: { ...process.env, GPIOZERO_PIN_FACTORY: 'mock', GPIOZERO_MOCK_PIN_CLASS: 'mockpwmpin', ROOMSENSE_MQTT_PASSWORD: NODE_PW }
  });
  let nodeLog = '';
  node.stdout.on('data', (d) => { nodeLog += d; });
  node.stderr.on('data', (d) => { nodeLog += d; });
  const room = () => db.collection('rooms').findOne({ _id: ROOM });
  check('node connects and reports online', await until(async () => (await room()).nodeStatus === 'online'));
  check('node publishes initial presence', await until(async () => (await db.collection('sensor_readings').findOne({ 'meta.type': 'presence' })) !== null));

  // 2. a fake sensor client stands in for sensors the mock Pi does not have
  const sim = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, { clientId: 'sim', username: 'sim', password: SIM_PW });
  await new Promise((r) => sim.on('connect', r));
  const results = [];
  sim.subscribe(`campus/${ROOM}/rfid/result`);
  sim.on('message', (topic, msg) => results.push(JSON.parse(msg)));
  const ts = Date.now() / 1000;
  sim.publish(`campus/${ROOM}/sensor/climate`, JSON.stringify({ ts, celsius: 23.6, humidity: 55.9, hPa: 993.0, gasOhms: 7753 }));
  sim.publish(`campus/${ROOM}/sensor/light`, JSON.stringify({ ts, lux: 281.8, saturated: false }));
  check('climate stored as 4 readings', await until(async () => (await db.collection('sensor_readings').find({ 'meta.roomId': ROOM }).toArray()).filter((r) => ['temperature', 'humidity', 'pressure', 'gas'].includes(r.meta.type)).length === 4));
  const detail = await (await fetch(`${API}/rooms/${ROOM}`)).json();
  check('GET /rooms/:id returns latest values', detail.latest && detail.latest.temperature.value === 23.6 && detail.latest.light.value === 281.8);
  const series = await (await fetch(`${API}/rooms/${ROOM}/readings?type=temperature&hours=1`)).json();
  check('GET /readings returns a series', Array.isArray(series) && series.length === 1 && series[0].value === 23.6);

  // 3. validation
  sim.publish(`campus/${ROOM}/sensor/climate`, 'not json');
  sim.publish(`campus/${ROOM}/sensor/climate`, JSON.stringify({ ts, celsius: 999, humidity: 50, hPa: 1000 }));
  check('bad payloads rejected and logged', await until(async () => (await db.collection('events').find({ type: 'bad_message' }).toArray()).length === 2));
  const before = (await room()).actuators.fan;
  sim.publish(`campus/${ROOM}/actuator/fan/set`, JSON.stringify({ on: true }));
  await sleep(800);
  check('a client cannot send actuator commands', JSON.stringify((await room()).actuators.fan) === JSON.stringify(before));

  // 4. web-triggered actuators reach the node and come back as state
  let res = await post(`${API}/rooms/${ROOM}/actuators/fan`, { on: true, speed: 0.8 });
  check('POST fan command accepted', res.status === 202);
  check('node applies fan and echoes state', await until(async () => { const f = (await room()).actuators.fan; return f && f.on === true && f.speed === 0.8; }));
  res = await post(`${API}/rooms/${ROOM}/actuators/light`, { on: true, level: 0.5 });
  check('node applies light level', res.status === 202 && await until(async () => { const l = (await room()).actuators.light; return l && l.level === 0.5; }));
  res = await post(`${API}/rooms/${ROOM}/actuators/heating`, { on: 'yes' });
  check('invalid command refused with 400', res.status === 400);
  res = await post(`${API}/rooms/${ROOM}/actuators/toaster`, { on: true });
  check('unknown actuator refused with 404', res.status === 404);
  check('override logged with source web', (await db.collection('events').find({ type: 'override', source: 'web' }).toArray()).length === 2);

  // 5. RFID: unknown badge, register it, then granted
  sim.publish(`campus/${ROOM}/sensor/rfid`, JSON.stringify({ ts, uid: '5900BF16C7' }), { qos: 1 });
  check('unknown badge denied', await until(() => results.some((r) => r.granted === false)));
  const unknown = await (await fetch(`${API}/rfid/last-unknown`)).json();
  check('last unknown badge available for registration', unknown && unknown.uid === '5900BF16C7');
  res = await post(`${API}/users`, { name: 'Usman', email: 'usman@example.org', rfidUid: unknown.uid });
  check('user registered', res.status === 201);
  res = await post(`${API}/users`, { name: 'Copy', rfidUid: '5900bf16c7' });
  check('same badge cannot be registered twice', res.status === 409);
  const stored = await db.collection('users').findOne({ name: 'Usman' });
  check('badge stored only as a hash', stored.rfidUidHash === hashUid('5900BF16C7') && !JSON.stringify(stored).includes('5900BF16C7'));
  sim.publish(`campus/${ROOM}/sensor/rfid`, JSON.stringify({ ts, uid: '5900BF16C7' }), { qos: 1 });
  check('registered badge granted', await until(() => results.some((r) => r.granted === true)));
  check('node received the result', await until(() => nodeLog.includes('badge granted')));
  await db.collection('rooms').insertOne({ _id: 'ME208', name: 'Room ME208', state: 'FREE', nodeStatus: 'offline', hasNode: false, settings: {}, actuators: {} });
  const later = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  res = await post(`${API}/bookings`, { roomId: 'ME208', userId: String(stored._id), start: later(2), end: later(3) });
  check('no booking in a room without a node (400)', res.status === 400, String(res.status));

  // 6. MQTT login and per-room rights
  const tryLogin = (opts) => new Promise((resolve) => {
    const c = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, { reconnectPeriod: 0, connectTimeout: 3000, ...opts });
    c.on('connect', () => { c.end(true); resolve('connected'); });
    c.on('error', (err) => { c.end(true); resolve(String(err.code ?? err.message)); });
  });
  const anon = await tryLogin({ clientId: 'anon' });
  check('no login: connection refused', anon !== 'connected', anon);
  const wrong = await tryLogin({ clientId: 'intruder', username: 'node-ME407', password: 'guess' });
  check('wrong password: connection refused', wrong !== 'connected', wrong);
  const fake = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, { clientId: 'fake-node', username: 'node-ME407', password: NODE_PW, reconnectPeriod: 0 });
  await new Promise((r) => fake.on('connect', r));
  // the broker answers with a refused grant (0x80); mqtt.js reports that as an error
  const granted = await new Promise((r) => fake.subscribe('campus/#', (err, g) => r(err ? 'refused' : g[0].qos)));
  check('node account cannot watch other rooms (campus/#)', granted === 'refused' || granted === 128, String(granted));
  const own = await new Promise((r) => fake.subscribe(`campus/${ROOM}/actuator/+/set`, (err, g) => r(err ? 'refused' : g[0].qos)));
  check('node account can subscribe to its own room', own === 1 || own === 0, String(own));
  await db.collection('rooms').insertOne({ _id: 'ME404', name: 'Other', state: 'FREE', nodeStatus: 'offline', comfortC: 19, ecoC: 16, luxThreshold: 150, actuators: {} });
  fake.publish('campus/ME404/sensor/light', JSON.stringify({ ts, lux: 1 }), { qos: 1 });
  await sleep(800);
  check('node account cannot publish for another room', !(await db.collection('sensor_readings').findOne({ 'meta.roomId': 'ME404' })));
  fake.end(true);

  // 7. Last Will: kill the node without warning
  node.kill('SIGKILL');
  check('broker marks the node offline (Last Will)', await until(async () => (await room()).nodeStatus === 'offline'));

  sim.end(true);
  http.close();
  await close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  if (failures) console.log('\n--- node log ---\n' + nodeLog);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
