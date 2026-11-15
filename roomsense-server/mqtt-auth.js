// MQTT accounts for the embedded broker.
//
// Accounts live in mqtt-users.json (path: MQTT_USERS_FILE), managed with `node scripts/mqtt-user.js`:
//   node  account (e.g. node-ME407): may publish and subscribe only under campus/<its room>/
//   admin account                  : may watch and publish under any room (debugging, robustness tests)
// Nobody, admin included, may publish actuator commands or badge results: only the server does (server.js).
// Passwords are stored as salted scrypt hashes, never in clear. With no account configured the broker
// stays open and the server prints a warning, so a fresh install still works out of the box.
//
// Limitation: plain MQTT on port 1883 sends the password unencrypted on the local network; TLS (port 8883)
// is the next step for a real deployment.
const fs = require('fs');
const crypto = require('crypto');

const KEYLEN = 32;
const NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const ROOM = /^[A-Za-z0-9_-]{1,20}$/;

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(String(password), salt, KEYLEN).toString('hex') });

function verify(account, password) {
  if (!account || password === undefined || password === null) return false;
  const given = crypto.scryptSync(Buffer.isBuffer(password) ? password : String(password), account.salt, KEYLEN);
  const stored = Buffer.from(account.hash, 'hex');
  return stored.length === given.length && crypto.timingSafeEqual(stored, given);
}

function loadUsers(file) {
  if (!file || !fs.existsSync(file)) return {};
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [name, a] of Object.entries(data)) {
    if (!NAME.test(name) || !a.salt || !a.hash || !['node', 'admin'].includes(a.role) || (a.role === 'node' && !ROOM.test(a.room || ''))) {
      throw new Error(`${file}: account "${name}" is malformed`);
    }
  }
  return data;
}

function saveUsers(file, users) {
  fs.writeFileSync(file, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
}

// Installs authenticate / authorizeSubscribe on the broker and returns a check for authorizePublish.
function protect(aedes, users) {
  const enabled = Object.keys(users || {}).length > 0;
  const fail = (code, msg) => Object.assign(new Error(msg), { returnCode: code });

  aedes.authenticate = (client, username, password, callback) => {
    if (!enabled) return callback(null, true);
    const account = users[username];
    if (!verify(account, password)) {
      console.warn(`MQTT login refused: ${username || '(no username)'} from ${client && client.conn && client.conn.remoteAddress}`);
      return callback(fail(4, 'bad user name or password'), false); // CONNACK 4 = bad user name or password
    }
    client.account = { name: username, role: account.role, room: account.room };
    return callback(null, true);
  };

  const allowed = (client, topic) => {
    if (!enabled || !client) return true;
    const a = client.account;
    if (!a) return false;
    if (a.role === 'admin') return topic.startsWith('campus/') || topic === '#';
    return topic.startsWith(`campus/${a.room}/`);
  };

  aedes.authorizeSubscribe = (client, sub, callback) => {
    if (allowed(client, sub.topic)) return callback(null, sub);
    console.warn(`MQTT subscribe refused: ${client.account ? client.account.name : client.id} -> ${sub.topic}`);
    return callback(null, null); // negative SUBACK for this topic, the connection stays up
  };

  return { enabled, mayPublish: (client, topic) => allowed(client, topic) };
}

module.exports = { protect, loadUsers, saveUsers, hashPassword, verify, NAME, ROOM };
