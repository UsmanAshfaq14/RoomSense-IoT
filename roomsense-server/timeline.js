// One room's day on a single time axis: what was scheduled, what was booked, when someone was actually there,
// and when the heating, the lights and the fan were on. Built from data the server already keeps:
//   bookings                      -> scheduled (timetable) and booked (bookings, walk-ins), cut at the real end
//   presence readings             -> occupied: motion, held for presenceTimeoutMin (the rule that keeps the lights on)
//   actuator echoes (heating_on…) -> what the Pi reports it actually did, not what was asked
//   node_online / node_offline    -> gaps where nothing could be seen
// Pure function: the route in server.js queries, this file only turns rows into intervals.

const clip = (a, b, from, to) => {
  const s = Math.max(a, from); const e = Math.min(b, to);
  return e > s ? [s, e] : null;
};

// [ts, value] rows (value 1 = on) -> on intervals. `before` = the state when the day starts.
function onIntervals(rows, before, from, to, holdMs = 0) {
  const spans = [];
  let openAt = before ? from : null;
  for (const { ts, value } of rows) {
    const t = new Date(ts).getTime();
    if (value && openAt === null) openAt = t;
    if (!value && openAt !== null) { spans.push([openAt, t + holdMs]); openAt = null; }
  }
  if (openAt !== null) spans.push([openAt, to]);
  // the hold can make spans overlap: merge, then clip to the day
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const lastSpan = merged[merged.length - 1];
    if (lastSpan && s[0] <= lastSpan[1]) lastSpan[1] = Math.max(lastSpan[1], s[1]);
    else merged.push([...s]);
  }
  return merged.map(([a, b]) => clip(a, b, from, to)).filter(Boolean);
}

// from/to = the day shown; until = min(now, end of day): what is still on is drawn up to now, not beyond
function dayTimeline({ bookings, presence, actuators, nodeEvents, before, from, to, until, holdMs }) {
  const iso = (ms) => new Date(ms).toISOString();
  const lane = (spans, extra = () => ({})) => spans.map((s, i) => ({ start: iso(s[0]), end: iso(s[1]), ...extra(i) }));

  const blocks = (list) => list.map((b) => {
    // an early check-in (booker badging 5 min before) starts the block at the check-in
    const start = Math.min(new Date(b.start).getTime(), b.checkInAt ? new Date(b.checkInAt).getTime() : Infinity);
    // a booking that ended early (released, no-show, checked out) is drawn up to its real end
    const end = b.endedAt && new Date(b.endedAt).getTime() < new Date(b.end).getTime() ? new Date(b.endedAt).getTime() : new Date(b.end).getTime();
    const c = clip(start, end, from, to);
    return c && { start: iso(c[0]), end: iso(c[1]), title: b.title || null, status: b.status, source: b.source, userName: b.userName || null };
  }).filter(Boolean);

  const nodeRows = nodeEvents.map((e) => ({ ts: e.ts, value: e.type === 'node_online' ? 1 : 0 }));
  const online = onIntervals(nodeRows, before.nodeOnline, from, until);
  const offline = [];
  let cursor = from;
  for (const [a, b] of online) { if (a > cursor) offline.push([cursor, a]); cursor = b; }
  if (cursor < until) offline.push([cursor, until]);

  return {
    from: iso(from), to: iso(to), now: iso(until),
    lanes: {
      scheduled: blocks(bookings.filter((b) => b.source === 'timetable')),
      booked: blocks(bookings.filter((b) => b.source !== 'timetable')),
      occupied: lane(onIntervals(presence, before.presence, from, until, holdMs)),
      heating: lane(onIntervals(actuators.heating_on || [], before.heating_on, from, until)),
      lights: lane(onIntervals(actuators.light_on || [], before.light_on, from, until)),
      fan: lane(onIntervals(actuators.fan_on || [], before.fan_on, from, until)),
      offline: lane(offline.filter(([a, b]) => b - a >= 60 * 1000))
    }
  };
}

module.exports = { dayTimeline, onIntervals };
