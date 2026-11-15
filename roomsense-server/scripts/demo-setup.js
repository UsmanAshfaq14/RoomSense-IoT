// Prepares a separate database for the live demo, so the demo never touches the real measurements.
//
//   node scripts/demo-setup.js            copies roomsense -> roomsense_demo, keeps the demo room free today
//   npm run demo                          then starts the server on roomsense_demo, minutes lasting one second
//
// Copied : users and badges, rooms and their settings, timetable classes (all still "to come", nothing judged).
// Not    : readings, statistics, the activity log, bookings made by people: the demo starts from a clean day.
// The demo room's classes of today are left out, so it is FREE when the presentation starts.
// Only the demo database is replaced; the real one is read, never written.
const { MongoClient } = require('mongodb');
const { setupDatabase } = require('../db');

async function copyForDemo(src, dst, { room = 'ME407', today = new Date() } = {}) {
  for (const name of ['users', 'rooms', 'bookings', 'events', 'daily_stats', 'sensor_readings']) {
    await dst.collection(name).deleteMany({});
  }
  await setupDatabase(dst, room);

  const users = await src.collection('users').find({}).toArray();
  if (users.length) await dst.collection('users').insertMany(users);

  const rooms = (await src.collection('rooms').find({}).toArray()).map((r) => ({
    ...r, state: 'FREE', nodeStatus: 'offline', actuators: {}, gasReady: false
  }));
  await dst.collection('rooms').deleteMany({});
  if (rooms.length) await dst.collection('rooms').insertMany(rooms);

  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(today);
  const sameDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d) === day;
  const classes = (await src.collection('bookings').find({ source: 'timetable' }).toArray())
    .filter((b) => !(b.roomId === room && sameDay(b.start)))
    .map((b) => {
      const { checkInAt, endedAt, endReason, attendees, ...rest } = b;
      return { ...rest, status: 'pending' };
    });
  if (classes.length) await dst.collection('bookings').insertMany(classes);
  return { users: users.length, rooms: rooms.length, classes: classes.length, freedDay: day };
}

async function main() {
  const room = (process.argv.find((a) => a.startsWith('--room=')) || '--room=ME407').slice(7);
  const from = process.env.DB_NAME || 'roomsense';
  const to = process.env.DEMO_DB_NAME || 'roomsense_demo';
  if (from === to) throw new Error('the demo database must differ from the real one');
  const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 4000 });
  await client.connect();
  const n = await copyForDemo(client.db(from), client.db(to), { room });
  console.log(`${to}: ${n.users} users, ${n.rooms} rooms, ${n.classes} timetable classes copied from ${from}`);
  console.log(`${room} has no class on ${n.freedDay} in the demo database: it starts FREE.`);
  console.log('\nNow stop the normal server and run:  npm run demo');
  await client.close();
}

if (require.main === module) {
  main().catch((err) => { console.error(`demo setup failed: ${err.message}`); process.exit(1); });
}
module.exports = { copyForDemo };
