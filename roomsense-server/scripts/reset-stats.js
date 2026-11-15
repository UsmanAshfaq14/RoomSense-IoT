// Clears the measurements collected while testing, so the report's figures start from a clean day.
//
//   npm run reset-stats            -> shows what would be removed, changes nothing
//   npm run reset-stats -- --yes   -> removes it (stop the server first: it keeps live counters in memory)
//
// Removed : daily statistics, the activity log, sensor readings, and every room booking / walk-in made by people.
// Changed : timetable classes that were already judged (checked in, no-show, released, completed) become
//           "unmonitored": they stay in the schedule for the building view, but no longer count as test results.
// Kept    : users and their badges, rooms and their settings, timetable classes still to come.
const { MongoClient } = require('mongodb');

const JUDGED = ['checked_in', 'no_show', 'released', 'completed'];

async function resetMeasurements(db, { apply = false } = {}) {
  const plan = [
    ['daily statistics', db.collection('daily_stats'), {}],
    ['activity log entries', db.collection('events'), {}],
    ['sensor readings', db.collection('sensor_readings'), {}],
    ['bookings and walk-ins made by people', db.collection('bookings'), { source: { $in: ['user', 'walk_in'] } }]
  ];
  const report = [];
  for (const [label, col, filter] of plan) {
    const n = await col.countDocuments(filter);
    if (apply && n) await col.deleteMany(filter);
    report.push(`${apply ? 'removed' : 'would remove'} ${n} ${label}`);
  }
  const judged = { source: 'timetable', status: { $in: JUDGED } };
  const n = await db.collection('bookings').countDocuments(judged);
  if (apply && n) await db.collection('bookings').updateMany(judged, { $set: { status: 'unmonitored', endReason: 'test period, measurements reset' } });
  report.push(`${apply ? 'reset' : 'would reset'} ${n} already-judged timetable classes to "unmonitored"`);
  return report;
}

async function main() {
  const apply = process.argv.includes('--yes');
  const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 4000 });
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'roomsense');
  for (const line of await resetMeasurements(db, { apply })) console.log(line);
  if (!apply) console.log('\nNothing changed. Run again with --yes to apply (stop the server first, then start it again).');
  else console.log('\nDone. Users, badges, rooms, settings and upcoming classes are untouched.');
  await client.close();
}

if (require.main === module) {
  main().catch((err) => { console.error(`reset failed: ${err.message}`); process.exit(1); });
}
module.exports = { resetMeasurements };
