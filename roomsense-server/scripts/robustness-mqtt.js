// Robustness checks against the RUNNING server's broker: refused logins, forbidden topics, bad payloads.
// Nothing invalid gets stored; the room's state is not changed.
//
//   node scripts/mqtt-user.js add tester --admin            (once, then restart the server)
//   node scripts/robustness-mqtt.js --password <tester password> [--node-password <the Pi's password>]
//
// Options: --host (default 127.0.0.1), --port (1883), --http (3000), --room (ME407), --user (tester).
// The node password (in the Pi's mqtt-password.txt) is optional: it adds the per-room rights checks.
const mqtt = require('mqtt');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const HOST = arg('host', '127.0.0.1'); const PORT = Number(arg('port', 1883)); const HTTP = Number(arg('http', 3000));
const ROOM = arg('room', 'ME407'); const USER = arg('user', 'tester'); const PASSWORD = arg('password');
const NODE_PASSWORD = arg('node-password');
const API = `http://${HOST}:${HTTP}/api`; // 127.0.0.1, not localhost: Node may resolve localhost to ::1, where the server does not listen

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`;
  console.log(line); results.push(line);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = (opts) => new Promise((resolve) => {
  const c = mqtt.connect(`mqtt://${HOST}:${PORT}`, { reconnectPeriod: 0, connectTimeout: 4000, ...opts });
  c.on('connect', () => resolve({ ok: true, client: c }));
  c.on('error', (err) => { c.end(true); resolve({ ok: false, code: err.code ?? err.message }); });
});
const badMessages = async () => (await (await fetch(`${API}/events?roomId=${ROOM}&limit=200`)).json()).filter((e) => e.type === 'bad_message').length;
const room = async () => (await fetch(`${API}/rooms/${ROOM}`)).json();

(async () => {
  if (!PASSWORD) { console.error('give --password of an admin account (node scripts/mqtt-user.js add tester --admin)'); process.exit(2); }
  console.log(`RoomSense robustness checks against ${HOST}:${PORT}, room ${ROOM}, ${new Date().toISOString()}\n`);

  const anon = await login({ clientId: 'robustness-anon' });
  check('no login: broker refuses the connection', !anon.ok, `code ${anon.code}`);
  const wrong = await login({ clientId: 'robustness-wrong', username: USER, password: 'not-the-password' });
  check('wrong password: broker refuses the connection', !wrong.ok, `code ${wrong.code}`);

  const admin = await login({ clientId: 'robustness-admin', username: USER, password: PASSWORD });
  check('admin account logs in', admin.ok, admin.ok ? '' : `code ${admin.code}; restart the server after creating the account`);
  if (!admin.ok) process.exit(1);
  const c = admin.client;
  const base = `campus/${ROOM}`;

  // 1. malformed and out-of-range payloads are refused and logged
  const bad0 = await badMessages();
  const ts = Date.now() / 1000;
  c.publish(`${base}/sensor/climate`, 'this is not json');
  c.publish(`${base}/sensor/climate`, JSON.stringify({ ts, celsius: 999, humidity: 50, hPa: 990 }));
  c.publish(`${base}/sensor/light`, JSON.stringify({ ts, lux: -5 }));
  c.publish(`${base}/sensor/rfid`, JSON.stringify({ ts, uid: 'DROP TABLE' }));
  c.publish(`${base}/sensor/presence`, JSON.stringify({ ts, presence: 'maybe' }));
  await sleep(1500);
  const bad1 = await badMessages();
  check('5 bad payloads (not JSON, 999 °C, negative lux, bad badge, bad presence): all refused and logged', bad1 - bad0 === 5, `${bad1 - bad0} logged`);
  const latest = (await room()).latest;
  check('none of them stored', !(latest.temperature && latest.temperature.value === 999) && !(latest.light && latest.light.value < 0));
  // 2. a client may never send actuator commands, even an admin; the broker also drops its connection
  const before = (await room()).actuators.heating;
  const want = !(before && before.on);
  c.publish(`${base}/actuator/heating/set`, JSON.stringify({ on: want }), { qos: 0 });
  await sleep(1500);
  check('the broker closes the connection of a client that tries', !c.connected);
  const after = (await room()).actuators.heating;
  check('client publishing a heating command: refused, heating unchanged', JSON.stringify(before) === JSON.stringify(after),
    `heating stays ${before ? (before.on ? 'on' : 'off') : 'unknown'}`);

  c.end(true);

  // 3. per-room rights of the Pi's account (optional)
  if (NODE_PASSWORD) {
    const node = await login({ clientId: 'robustness-node', username: `node-${ROOM}`, password: NODE_PASSWORD });
    check(`node-${ROOM} logs in (a second session; the real Pi stays connected under its own client id)`, node.ok);
    if (node.ok) {
      const n = node.client;
      const g = await new Promise((r) => n.subscribe('campus/#', (err, granted) => r(err ? 'refused' : granted[0].qos)));
      check(`node-${ROOM} cannot watch every room (campus/#)`, g === 'refused' || g === 128, String(g));
      n.publish('campus/ME404/sensor/light', JSON.stringify({ ts, lux: 123 }), { qos: 1 });
      await sleep(1500);
      const other = await (await fetch(`${API}/rooms/ME404/readings?type=light&hours=1`)).json().catch(() => []);
      check(`node-${ROOM} cannot publish readings for ME404`, Array.isArray(other) && !other.some((p) => p.value === 123));
      n.end(true);
    }
  } else {
    console.log('(skipped per-room checks: add --node-password <the Pi\'s password> to run them)');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall robustness checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(`could not run: ${err.message} (is the server running?)`); process.exit(1); });
