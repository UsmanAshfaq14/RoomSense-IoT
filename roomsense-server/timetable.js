// Timetable import: turns a university timetable export into RoomSense bookings (source "timetable").
// Accepts an iCalendar file (.ics) or the text Outlook shows for forwarded timetable invitations.
// Keeps only the room, start, end and course code: teacher names and descriptions are dropped on purpose.

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
const TZ = 'Europe/Paris';

// Offset (ms) of a time zone at a given instant, using the built-in Intl data (no library).
function tzOffset(utcMs, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}
// Wall-clock time in a zone -> Date (handles summer/winter time).
function zoned(y, mo, d, h = 0, mi = 0, s = 0, tz = TZ) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  let utc = guess - tzOffset(guess, tz);
  utc = guess - tzOffset(utc, tz);
  return new Date(utc);
}

// "ME407.1" -> "ME407", "Salle ME 404" -> "ME404". Returns null when no room code is found.
function roomCode(location) {
  return roomCodes(location)[0] || null;
}

// ADE lists shared sessions as "ME403,ME407.1" (or a long list for maintenance): every room counts.
function roomCodes(location) {
  const out = [];
  for (const m of String(location || '').toUpperCase().matchAll(/([A-Z]{1,3})\s?(\d{3})/g)) {
    const code = `${m[1]}${m[2]}`;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

function parseIcsDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  const tzid = (/TZID=([^;:]+)/.exec(params || '') || [])[1] || TZ;
  try {
    return zoned(+y, +mo - 1, +d, +h, +mi, +s, tzid);
  } catch (err) {
    return zoned(+y, +mo - 1, +d, +h, +mi, +s, TZ); // unknown TZID name: assume Paris
  }
}

function parseIcs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n'); // unfold continuation lines
  const sessions = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') { if (ev) sessions.push(ev); ev = null; continue; }
    if (!ev) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1).replace(/\\,/g, ',').replace(/\\n/gi, ' ').replace(/\\;/g, ';');
    const [name, ...params] = head.split(';');
    if (name === 'DTSTART') ev.start = parseIcsDate(value, params.join(';'));
    else if (name === 'DTEND') ev.end = parseIcsDate(value, params.join(';'));
    else if (name === 'LOCATION') ev.location = value.trim();
    else if (name === 'SUMMARY') ev.title = value.trim();
  }
  return sessions;
}

// Outlook preview text: "Time / Wednesday, December 16, 2026 09:30 to 12:30 / Location / ME407.1 / Description / ILMCA2TD02 / ..."
function parseOutlookText(text) {
  const re = /Time\s*\n\s*\w+,\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s+to\s+(\d{1,2}):(\d{2})\s*\n\s*Location\s*\n\s*([^\n]+?)\s*\n\s*Description\s*\n\s*(?:\n\s*)*([^\n]*)/g;
  const sessions = [];
  let m;
  while ((m = re.exec(text.replace(/\r\n/g, '\n'))) !== null) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month === undefined) continue;
    sessions.push({
      start: zoned(+m[3], month, +m[2], +m[4], +m[5]),
      end: zoned(+m[3], month, +m[2], +m[6], +m[7]),
      location: m[8].trim(),
      title: m[9].trim()
    });
  }
  return sessions;
}

// Rooms listed in every event of an .ics file: that file is the room's own calendar (ADE "room" export),
// so every class in the room is known. A group timetable lists many rooms and covers none of them fully.
function fullCalendarRooms(text) {
  if (!/BEGIN:VCALENDAR/.test(text)) return [];
  const events = parseIcs(text);
  if (events.length < 3) return [];
  let common = roomCodes(events[0].location);
  for (const ev of events.slice(1)) {
    const here = roomCodes(ev.location);
    common = common.filter((c) => here.includes(c));
    if (!common.length) break;
  }
  return common;
}

function parseTimetable(text) {
  const raw = /BEGIN:VCALENDAR/.test(text) ? parseIcs(text) : parseOutlookText(text);
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    if (!(s.start instanceof Date) || !(s.end instanceof Date) || !(s.end > s.start)) continue;
    for (const roomId of roomCodes(s.location)) {
      const key = `${roomId}|${s.start.toISOString()}|${s.end.toISOString()}`;
      if (seen.has(key)) continue; // the same session exported twice
      seen.add(key);
      // Keep a short course code or title (ILMCA2TD02, "Cours de gestion"); descriptions, where teacher names live, are never read.
      const code = /^[\p{L}\p{N} _.,'()/-]{2,60}$/u.test(s.title || '') ? s.title : null;
      out.push({ roomId, location: s.location, start: s.start, end: s.end, title: code });
    }
  }
  return out;
}

module.exports = { parseTimetable, parseIcs, parseOutlookText, fullCalendarRooms, roomCode, roomCodes, zoned };
