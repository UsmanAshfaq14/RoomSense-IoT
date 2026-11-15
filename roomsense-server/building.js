// Building overview: for every room of a floor, how much of a teaching week is actually scheduled, from the
// timetable and room bookings. Works for rooms without a sensor, which is the point: it shows where a node would pay off.
//
// Week = Monday to Friday (Europe/Paris). Open hours = 08:00-19:00, the usual building heating schedule, so
// "empty" = open but nothing scheduled. Saving estimate = what a schedule-driven setpoint (eco instead of comfort
// in empty open hours) would avoid: heatingPowerW x 7 % per degree x (comfortC - ecoC) x empty hours. This is
// the same ADEME rule of thumb the room logic uses; it is an order of magnitude, not a measurement.
// Share and saving are only computed for rooms whose own calendar was imported (calendarFullSince): for the
// others only some classes are known (a group timetable), and "empty" would be a false claim.
const { zoned } = require('./timetable');

const OPEN_FROM = 8;
const OPEN_TO = 19;
const SAVING_PER_DEGREE = 0.07;
const H = 3600 * 1000;

const parisParts = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month - 1, d: +p.day, wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) };
};

// The five weekdays of the week containing `date`, each with its open-hours window.
function weekDays(date) {
  const p = parisParts(date);
  const monday = new Date(Date.UTC(p.y, p.mo, p.d - p.wd, 12));
  return [0, 1, 2, 3, 4].map((i) => {
    const day = new Date(monday.getTime() + i * 24 * H);
    const y = day.getUTCFullYear(); const mo = day.getUTCMonth(); const d = day.getUTCDate();
    return {
      date: `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      dayStart: zoned(y, mo, d, 0, 0), dayEnd: zoned(y, mo, d + 1, 0, 0),
      open: zoned(y, mo, d, OPEN_FROM, 0), close: zoned(y, mo, d, OPEN_TO, 0)
    };
  });
}

// Overlapping sessions (two groups sharing a room, a booking on top of a class) count once.
function merge(list) {
  const sorted = list.map((b) => ({ start: +b.start, end: +b.end, titles: [b.title || 'class'] })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
      if (!last.titles.includes(b.titles[0])) last.titles.push(b.titles[0]);
    } else out.push({ ...b });
  }
  return out;
}

const overlapH = (s, e, from, to) => Math.max(0, Math.min(e, +to) - Math.max(s, +from)) / H;
const round1 = (x) => Math.round(x * 10) / 10;

function summarise({ rooms, bookings, stats, date, now, defaults }) {
  const days = weekDays(date);
  const openH = days.length * (OPEN_TO - OPEN_FROM);
  const t = +now;
  const result = rooms.map((room) => {
    const mine = bookings.filter((b) => b.roomId === room._id);
    const planned = mine.filter((b) => b.source !== 'walk_in' && b.status !== 'cancelled');
    let inOpen = 0; let outside = 0; let sessions = 0;
    const perDay = days.map((day) => {
      const blocks = merge(planned.filter((b) => b.start < day.dayEnd && b.end > day.dayStart));
      for (const b of blocks) {
        const total = overlapH(b.start, b.end, day.dayStart, day.dayEnd);
        const open = overlapH(b.start, b.end, day.open, day.close);
        inOpen += open; outside += total - open;
      }
      sessions += planned.filter((b) => b.start >= day.dayStart && b.start < day.dayEnd).length;
      return {
        date: day.date,
        blocks: blocks.map((b) => ({ start: new Date(Math.max(b.start, +day.dayStart)), end: new Date(Math.min(b.end, +day.dayEnd)), title: b.titles.join(' + ') }))
      };
    });
    const comfort = room.comfortC ?? defaults.comfortC;
    const eco = room.ecoC ?? defaults.ecoC;
    const power = room.heatingPowerW ?? defaults.heatingPowerW;
    const full = Boolean(room.calendarFullSince) && +room.calendarFullSince <= +days[4].dayEnd;
    const emptyH = openH - inOpen;
    const current = mine.find((b) => b.status !== 'cancelled' && +b.start <= t && +b.end > t && b.status !== 'no_show' && b.status !== 'released');
    const next = mine.filter((b) => b.status === 'pending' && +b.start > t).sort((a, b) => a.start - b.start)[0];
    const out = {
      roomId: room._id, name: room.name, hasNode: room.hasNode !== false, state: room.state, nodeStatus: room.nodeStatus,
      now: current ? { title: current.title || (current.source === 'timetable' ? 'class' : 'booking'), until: current.end, monitored: current.status !== 'unmonitored' && room.hasNode !== false } : null,
      next: next ? { title: next.title || (next.source === 'timetable' ? 'class' : 'booking'), start: next.start } : null,
      sessions,
      scheduledH: round1(inOpen + outside), inOpenH: round1(inOpen), outsideOpenH: round1(outside),
      calendar: full ? 'full' : 'partial',
      openH, sharePct: full ? Math.round((inOpen / openH) * 100) : null, emptyH: full ? round1(emptyH) : null,
      estKWhAvoidable: full ? round1((power / 1000) * SAVING_PER_DEGREE * Math.max(0, comfort - eco) * emptyH) : null,
      days: perDay
    };
    if (out.hasNode) {
      const week = stats.filter((s) => s.roomId === room._id && s.date >= days[0].date && s.date <= days[4].date);
      const sum = (k) => week.reduce((a, s) => a + (s[k] || 0), 0);
      out.measured = { bookedH: round1(sum('bookedMin') / 60), occupiedH: round1(sum('occupiedMin') / 60), noShows: sum('noShows') };
    }
    return out;
  });
  const known = result.filter((r) => r.calendar === 'full');
  const total = (k) => round1(known.reduce((a, r) => a + r[k], 0));
  return {
    week: { from: days[0].date, to: days[4].date, openFrom: OPEN_FROM, openTo: OPEN_TO },
    assumptions: `Open ${OPEN_FROM}:00-${OPEN_TO}:00 on weekdays. Saving = heater power x ${Math.round(SAVING_PER_DEGREE * 100)} % per degree x (comfort - eco) x empty open hours; an estimate, not a measurement. Totals cover only rooms whose full calendar was imported.`,
    totals: {
      rooms: result.length, fullCalendarRooms: known.length, sessions: known.reduce((a, r) => a + r.sessions, 0),
      scheduledH: total('scheduledH'), openH: known.length * openH,
      sharePct: known.length ? Math.round((known.reduce((a, r) => a + r.inOpenH, 0) / (known.length * openH)) * 100) : null,
      emptyH: total('emptyH'), estKWhAvoidable: total('estKWhAvoidable')
    },
    rooms: result
  };
}

module.exports = { summarise, weekDays, merge, OPEN_FROM, OPEN_TO };
