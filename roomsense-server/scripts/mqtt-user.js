// Manage MQTT accounts (mqtt-users.json). Restart the server after a change.
//
//   node scripts/mqtt-user.js add node-ME407 --room ME407   one account per Pi; prints its new password once
//   node scripts/mqtt-user.js add admin --admin              a debugging account that can see every room
//   node scripts/mqtt-user.js list
//   node scripts/mqtt-user.js remove node-ME407
// (npm run mqtt-user -- ... works too, but Windows PowerShell may swallow the "--")
//
// The password is generated here and shown once; only its scrypt hash is stored. Put it on the Pi in
// mqtt-password.txt next to roomsense_node.py.
const path = require('path');
const crypto = require('crypto');
const { loadUsers, saveUsers, hashPassword, NAME, ROOM } = require('../mqtt-auth');

const FILE = process.env.MQTT_USERS_FILE || path.join(__dirname, '..', 'mqtt-users.json');

function usage(msg) {
  if (msg) console.error(`${msg}\n`);
  console.error('usage: node scripts/mqtt-user.js add <name> (--room <ROOM> | --admin)\n       node scripts/mqtt-user.js list\n       node scripts/mqtt-user.js remove <name>');
  process.exit(1);
}

function main(argv) {
  const [cmd, name, ...rest] = argv;
  const users = loadUsers(FILE);
  if (cmd === 'list') {
    const rows = Object.entries(users);
    if (!rows.length) console.log(`no accounts in ${FILE}: MQTT login is off`);
    for (const [n, a] of rows) console.log(`${n.padEnd(20)} ${a.role === 'admin' ? 'admin (all rooms)' : `node of ${a.room}`}`);
    return;
  }
  if (!name) usage('missing account name');
  if (cmd === 'remove') {
    if (!users[name]) usage(`no account named ${name}`);
    delete users[name];
    saveUsers(FILE, users);
    console.log(`removed ${name}; restart the server`);
    return;
  }
  if (cmd !== 'add') usage(`unknown command ${cmd || ''}`);
  if (!NAME.test(name)) usage('name: letters, digits, . _ - only (max 40)');
  const admin = rest.includes('--admin');
  const room = rest[rest.indexOf('--room') + 1];
  if (!admin && (!rest.includes('--room') || !ROOM.test(room || ''))) usage('give --room <ROOM> for a node account, or --admin');
  const password = crypto.randomBytes(18).toString('base64url');
  users[name] = { role: admin ? 'admin' : 'node', ...(admin ? {} : { room }), ...hashPassword(password), createdAt: new Date().toISOString() };
  saveUsers(FILE, users);
  console.log(`saved ${name} (${admin ? 'admin' : `node of ${room}`}) in ${FILE}`);
  console.log(`\npassword (shown only now): ${password}\n`);
  if (!admin) console.log(`On the Pi, in the folder of roomsense_node.py:\n  printf '%s\\n' '${password}' > mqtt-password.txt && chmod 600 mqtt-password.txt`);
  console.log('Then restart the server.');
}

main(process.argv.slice(2));
