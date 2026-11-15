// RoomSense room logic: turns bookings, badges and sensor readings into room states and actuator commands.
//
// Room states:  FREE -> RESERVED (a booking starts within preheatMin) -> OCCUPIED (check-in) -> FREE
//   check-in   : the booker's badge, any registered badge for a timetabled class, or presence during a class
//   no-show    : nobody checked in graceMin after the start -> booking no_show, room FREE, heating eco
//   release    : OCCUPIED but no presence for releaseTimeoutMin -> booking released, room FREE
//   check-out  : the booker badges again while OCCUPIED
//   walk-in    : a registered badge on a FREE room books it on the spot (up to 60 min, never over the next booking)
//
// Actuator rules (only sent when the wanted state changes; a manual web override pauses the rule for overrideMin):
//   heating : comfortC when RESERVED/OCCUPIED, ecoC when FREE, 0.5 degC hysteresis
//   light   : OCCUPIED + presence in the last presenceTimeoutMin + light below luxThreshold (off again above 2x threshold)
//   fan     : OCCUPIED + air alert (humidity above humidityMax or gas resistance below gasMinOhms)
//   status  : free / reserved / occupied
//
// Demo mode (DEMO=1): every "minute" in the room logic lasts one second, so a 10 min grace period takes 10 s.

const MIN = 60 * 1000;
const dayKey = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const hhmm = (d) => d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const DEFAULTS = {
  preheatMin: 15, graceMin: 10, presenceTimeoutMin: 15, releaseTimeoutMin: 30,
  walkInMin: 60, overrideMin: 30, humidityMax: 70, gasMinOhms: 10000,
  comfortC: 19, ecoC: 16, luxThreshold: 150, lightPowerW: 200, heatingPowerW: 1500
};
const HEATING_SAVING_PER_DEGREE = 0.07; // ADEME rule of thumb: about 7 % less heating energy per degree lowered

function createEngine({ db, publish, logEvent, broadcast, now = () => new Date(), demo = false }) {
  const unit = demo ? 1000 : MIN;
  const rooms = db.collection('rooms');
  const bookings = db.collection('bookings');
  const users = db.collection('users');
  const stats = db.collection('daily_stats');
  const live = new Map();

  function L(roomId) {
    if (!live.has(roomId)) {
      live.set(roomId, {
        values: {}, presence: false, lastPresenceAt: null, sent: {}, overrides: {}, onlineSince: null,
        airAlert: false, savingUntil: null, lastTick: null, chain: Promise.resolve()
      });
    }
    return live.get(roomId);
  }
  // One room's work runs strictly one step at a time, so a tick and a badge never close the same booking twice.
  function serial(roomId, fn) {
    const st = L(roomId);
    const run = st.chain.then(fn, fn);
    st.chain = run.catch(() => {});
    return run;
  }
  const cfg = (room, key) => (room[key] ?? DEFAULTS[key]);
  const span = (room, key) => cfg(room, key) * unit;

  // A booking is judged (no-show, release) only if the room was watched from its start: server running AND the
  // room node online. A class that began while the server was off or the Pi unplugged cannot be called a no-show,
  // since nothing could see who came; it stays open for a badge or motion and otherwise ends "unmonitored".
  const watchedFrom = (st, b) => Boolean(st.onlineSince && st.onlineSince <= b.start);
  // Wi-Fi blips: a node back within RECONNECT_GRACE_MS (real time, also in demo mode) counts as watched all along,
  // otherwise every one-second drop would make the booking in progress unjudgeable.
  const RECONNECT_GRACE_MS = 2 * 60 * 1000;
  function markOnline(st) {
    if (st.onlineSince) return;
    const t = now();
    const blip = st.offlineAt && st.watchedBefore && t - st.offlineAt <= RECONNECT_GRACE_MS;
    st.onlineSince = blip ? st.watchedBefore : t;
    st.offlineAt = null; st.watchedBefore = null;
  }
  const NOT_WATCHED = 'not watched from its start (server or room node off)';

  async function closeBooking(room, b, status, reason, t) {
    const st = L(room._id);
    await bookings.updateOne({ _id: b._id }, { $set: { status, endedAt: t, endReason: reason } });
    if ((status === 'no_show' || status === 'released') && b.end > t) {
      st.savingUntil = st.savingUntil && st.savingUntil > b.end ? st.savingUntil : b.end;
    }
    if (status === 'no_show') await stats.updateOne({ roomId: room._id, date: dayKey(t) }, { $inc: { noShows: 1 } }, { upsert: true });
    const type = { no_show: 'no_show', released: 'released', completed: 'completed', unmonitored: 'not_monitored' }[status];
    await logEvent(room._id, type, 'auto', { bookingId: String(b._id), reason, title: b.title || null }, b.userId || null);
    broadcast('booking', { roomId: room._id, bookingId: b._id, status, reason });
  }

  async function checkIn(room, b, user, t, how) {
    await bookings.updateOne({ _id: b._id }, { $set: { status: 'checked_in', checkInAt: t } });
    L(room._id).lastPresenceAt = t;
    await logEvent(room._id, 'check_in', 'node', { bookingId: String(b._id), how }, user ? user._id : null);
    broadcast('booking', { roomId: room._id, bookingId: b._id, status: 'checked_in', how });
  }

  async function nextPending(roomId, t, room) {
    const horizon = new Date(t.getTime() + span(room, 'preheatMin'));
    const list = await bookings.find({ roomId, status: 'pending', start: { $lte: horizon }, end: { $gt: t } })
      .sort({ start: 1 }).limit(1).toArray();
    return list[0] || null;
  }

  async function applyActuators(room, st, state, t) {
    const v = st.values;
    const want = {};
    want.status = { state: room.nodeStatus === 'offline' ? 'offline' : state.toLowerCase() };

    const setpoint = state === 'FREE' ? cfg(room, 'ecoC') : cfg(room, 'comfortC');
    let heat = st.sent.heating ? st.sent.heating.on : false;
    if (isNum(v.temperature)) {
      if (v.temperature < setpoint - 0.5) heat = true;
      else if (v.temperature > setpoint + 0.5) heat = false;
    }
    want.heating = { on: heat };

    const recent = st.lastPresenceAt && t - st.lastPresenceAt < span(room, 'presenceTimeoutMin');
    const lightIsOn = Boolean(st.sent.light && st.sent.light.on);
    const thr = cfg(room, 'luxThreshold');
    const dark = !isNum(v.light) || (lightIsOn ? v.light < thr * 2 : v.light < thr);
    want.light = { on: Boolean(state === 'OCCUPIED' && recent && dark), level: 1 };

    const hMax = cfg(room, 'humidityMax');
    const gMin = cfg(room, 'gasMinOhms');
    const bad = (isNum(v.humidity) && v.humidity > hMax) || (isNum(v.gas) && v.gas < gMin);
    const clear = !(isNum(v.humidity) && v.humidity > hMax - 5) && !(isNum(v.gas) && v.gas < gMin * 1.2);
    if (!st.airAlert && bad) {
      st.airAlert = true;
      await logEvent(room._id, 'air_alert', 'auto', { humidity: v.humidity ?? null, gas: v.gas ?? null });
      broadcast('air', { roomId: room._id, alert: true });
    } else if (st.airAlert && clear) {
      st.airAlert = false;
      broadcast('air', { roomId: room._id, alert: false });
    }
    want.fan = { on: st.airAlert && state === 'OCCUPIED', speed: 0.9 };

    for (const [name, command] of Object.entries(want)) {
      const ov = st.overrides[name];
      if (ov && ov.until > t) continue;
      if (ov) delete st.overrides[name];
      if (same(st.sent[name], command)) continue;
      await publish(`campus/${room._id}/actuator/${name}/set`, command, { qos: 1, retain: true });
      const before = st.sent[name];
      st.sent[name] = command;
      if (name !== 'status' && before !== undefined && before.on !== command.on) {
        await logEvent(room._id, `${name}_${command.on ? 'on' : 'off'}`, 'auto', { command });
      }
    }
  }

  async function addStats(room, st, state, t) {
    // usage is only counted while the room is watched: minutes with the node offline say nothing about use
    if (!st.lastTick || !st.onlineSince) { st.lastTick = t; return; }
    const dtMin = (t - st.lastTick) / MIN;
    st.lastTick = t;
    if (dtMin <= 0 || dtMin > 10) return; // skip gaps (server stopped, clock jump)
    const on = st.sent;
    const booked = state !== 'FREE';
    const inc = {};
    if (booked) inc.bookedMin = dtMin;
    // occupied = someone there during booked time, so "share of booked time used" never exceeds 100 %.
    // A PIR sees motion, not people: someone reading at a desk barely moves, so a minute counts as occupied
    // while motion was seen in the last presenceTimeoutMin (the same rule that keeps the lights on).
    // Use of a free room (no booking) is counted separately.
    const present = st.presence || Boolean(st.lastPresenceAt && t - st.lastPresenceAt < span(room, 'presenceTimeoutMin'));
    if (present && booked) inc.occupiedMin = dtMin;
    if (present && !booked) inc.unbookedPresenceMin = dtMin;
    if (on.light && on.light.on) inc.lightsOnMin = dtMin;
    if (on.heating && on.heating.on) inc.heatingOnMin = dtMin;
    if (on.fan && on.fan.on) inc.fanOnMin = dtMin;
    // Baseline without RoomSense: lights on for the whole booked time.
    if (booked && !(on.light && on.light.on)) inc.estLightWhAvoided = cfg(room, 'lightPowerW') * dtMin / 60;
    // Baseline: the room stays at comfort for a booking nobody used; RoomSense drops it to eco.
    if (state === 'FREE' && st.savingUntil && t < st.savingUntil) {
      const fraction = HEATING_SAVING_PER_DEGREE * (cfg(room, 'comfortC') - cfg(room, 'ecoC'));
      inc.estHeatWhAvoided = cfg(room, 'heatingPowerW') * fraction * dtMin / 60;
    }
    if (Object.keys(inc).length) await stats.updateOne({ roomId: room._id, date: dayKey(t) }, { $inc: inc }, { upsert: true });
  }

  // A room known only from the timetable has no sensor and no actuators: its state follows the schedule,
  // and its classes are never judged (no no-show, no usage figures), because nothing could see if they happened.
  async function scheduleOnly(room, t) {
    const inClass = await bookings.findOne({ roomId: room._id, status: { $in: ['pending', 'checked_in', 'unmonitored'] }, start: { $lte: t }, end: { $gt: t } });
    const state = inClass ? 'RESERVED' : 'FREE';
    if (state !== room.state) {
      await rooms.updateOne({ _id: room._id }, { $set: { state } });
      room.state = state;
      broadcast('room', { roomId: room._id, state });
    }
    return state;
  }

  async function step(room, withStats) {
    const t = now();
    if (room.hasNode === false) return scheduleOnly(room, t);
    const st = L(room._id);
    if (st.presence && st.onlineSince) st.lastPresenceAt = t;

    for (const b of await bookings.find({ roomId: room._id, status: 'pending', end: { $lte: t } }).toArray()) {
      if (watchedFrom(st, b)) await closeBooking(room, b, 'no_show', 'never checked in', t);
      else await closeBooking(room, b, 'unmonitored', NOT_WATCHED, t);
    }

    let active = await bookings.findOne({ roomId: room._id, status: 'checked_in' });
    if (active) {
      // with the node offline nobody's motion can be seen: never release for "no motion" while not watching
      const lastSeen = Math.max(st.lastPresenceAt ? st.lastPresenceAt.getTime() : 0, active.checkInAt.getTime(),
        st.onlineSince ? st.onlineSince.getTime() : 0);
      if (t >= active.end) {
        await closeBooking(room, active, 'completed', 'booking ended', t);
        active = null;
      } else if (st.onlineSince && t.getTime() - lastSeen >= span(room, 'releaseTimeoutMin')) {
        await closeBooking(room, active, 'released', `no presence for ${cfg(room, 'releaseTimeoutMin')} min`, t);
        active = null;
      }
    }

    let upcoming = null;
    if (!active) {
      upcoming = await nextPending(room._id, t, room);
      if (upcoming) {
        const started = t >= upcoming.start;
        const seenSinceStart = st.lastPresenceAt && st.lastPresenceAt >= upcoming.start;
        if (upcoming.source === 'timetable' && started && seenSinceStart) {
          await checkIn(room, upcoming, null, t, 'presence');
          active = upcoming;
          upcoming = null;
        } else if (t - upcoming.start >= span(room, 'graceMin') && watchedFrom(st, upcoming)) {
          await closeBooking(room, upcoming, 'no_show', 'nobody checked in', t);
          upcoming = await nextPending(room._id, t, room);
          if (upcoming && t - upcoming.start >= span(room, 'graceMin') && watchedFrom(st, upcoming)) upcoming = null;
        }
      }
    }

    const state = active ? 'OCCUPIED' : upcoming ? 'RESERVED' : 'FREE';
    if (state !== room.state) {
      await rooms.updateOne({ _id: room._id }, { $set: { state } });
      room.state = state;
      broadcast('room', { roomId: room._id, state });
    }
    await applyActuators(room, st, state, t);
    if (withStats) await addStats(room, st, state, t);
    return state;
  }

  async function evaluate(roomId, withStats = false) {
    return serial(roomId, async () => {
      const room = await rooms.findOne({ _id: roomId });
      return room ? step(room, withStats) : null;
    });
  }

  return {
    unit,
    live: (roomId) => {
      const st = L(roomId);
      return { airAlert: st.airAlert, presence: st.presence, lastPresenceAt: st.lastPresenceAt, overrides: st.overrides, sent: st.sent, onlineSince: st.onlineSince };
    },

    // The deadlines the room logic is working towards, as absolute times, so the dashboard can count down
    // (in demo mode a "minute" is a second, which the absolute times already include).
    clock(room, current, next) {
      const t = now();
      const st = L(room._id);
      const out = { serverNow: t, unitMs: unit, watching: Boolean(st.onlineSince) };
      if (room.hasNode === false) return { ...out, mode: 'timetable' };
      if (current) {
        const lastSeen = Math.max(st.lastPresenceAt ? st.lastPresenceAt.getTime() : 0, current.checkInAt ? new Date(current.checkInAt).getTime() : 0,
          st.onlineSince ? st.onlineSince.getTime() : 0);
        const releaseAt = st.onlineSince && !st.presence ? new Date(lastSeen + span(room, 'releaseTimeoutMin')) : null;
        return {
          ...out, mode: 'in_use', endsAt: current.end, motionNow: Boolean(st.presence),
          releaseAt: releaseAt && releaseAt < current.end ? releaseAt : null,
          attendees: (current.attendees || []).length
        };
      }
      if (next) {
        const start = new Date(next.start);
        // a booking still to come is watched if the node is online now and stays so; one already started only
        // if the node was online at its start
        const watched = Boolean(st.onlineSince && (start > t || st.onlineSince <= start));
        return {
          ...out, mode: start > t ? 'booked' : 'waiting', startsAt: start, endsAt: next.end,
          preheatAt: new Date(start.getTime() - span(room, 'preheatMin')),
          noShowAt: watched ? new Date(start.getTime() + span(room, 'graceMin')) : null
        };
      }
      return { ...out, mode: 'free' };
    },

    async tick() {
      for (const room of await rooms.find({}).toArray()) await evaluate(room._id, true);
    },
    evaluate,

    // All values of one message are stored first, then the room is evaluated once.
    async onReadings(roomId, pairs) {
      const st = L(roomId);
      markOnline(st); // a reading proves the node is there, even if its status was missed
      for (const [type, value] of pairs) {
        st.values[type] = value;
        if (type === 'presence') {
          st.presence = value === 1;
          if (st.presence) st.lastPresenceAt = now();
        }
      }
      await evaluate(roomId);
    },

    async onNodeStatus(roomId, status) {
      const st = L(roomId);
      if (status === 'online') {
        st.sent = {}; // the node restarted: send every wanted state again
        markOnline(st);
      } else {
        if (st.onlineSince) { st.watchedBefore = st.onlineSince; st.offlineAt = now(); }
        st.onlineSince = null;
        st.presence = false; // the last motion state of a node that is gone says nothing any more
      }
      await evaluate(roomId);
    },

    setOverride(roomId, name, command) {
      const st = L(roomId);
      if (command === null) { delete st.overrides[name]; return null; }
      return serial(roomId, async () => {
        const room = await rooms.findOne({ _id: roomId });
        const until = new Date(now().getTime() + span(room || {}, 'overrideMin'));
        st.overrides[name] = { until, command };
        st.sent[name] = command;
        return until;
      });
    },

    onBadge(roomId, user) {
      return serial(roomId, async () => {
        if (!user) return { granted: false, reason: 'unknown badge' };
        const t = now();
        const room = await rooms.findOne({ _id: roomId });
        if (!room) return { granted: false, reason: 'unknown room' };
        const isAdmin = user.role === 'admin';
        const mine = (b) => b.userId && String(b.userId) === String(user._id);

        // There is no door lock: a badge says who is using the room. So once a class or a booking is running,
        // any registered badge is welcome and joins it (recorded as an attendee); only the booker's badge ends it.
        const active = await bookings.findOne({ roomId, status: 'checked_in' });
        if (active) {
          if (mine(active)) {
            await closeBooking(room, active, 'completed', 'checked out by badge', t);
            await step(room, false);
            return { granted: true, reason: 'checked out, room released' };
          }
          await bookings.updateOne({ _id: active._id }, { $addToSet: { attendees: user._id } });
          L(roomId).lastPresenceAt = t; // someone just badged in: the room is in use
          if (active.source === 'timetable') return { granted: true, reason: `welcome, class until ${hhmm(active.end)}` };
          const booker = active.userId ? await users.findOne({ _id: active.userId }) : null;
          return { granted: true, reason: `joined ${booker ? `${booker.name}'s` : 'the'} booking until ${hhmm(active.end)}` };
        }

        const pending = await nextPending(roomId, t, room);
        // within the grace period, or a booking that started while nobody was watching (not judged, still open)
        if (pending && (t - pending.start < span(room, 'graceMin') || !watchedFrom(L(roomId), pending))) {
          if (pending.source === 'timetable' || mine(pending)) {
            await checkIn(room, pending, user, t, 'badge');
            await bookings.updateOne({ _id: pending._id }, { $addToSet: { attendees: user._id } });
            await step(room, false);
            return { granted: true, reason: `checked in until ${hhmm(pending.end)}` };
          }
          // someone else's booking that has not started yet: nobody may take it over before the booker arrives
          return isAdmin ? { granted: true, reason: 'admin access' } : { granted: false, reason: 'room booked by someone else' };
        }

        const later = await bookings.find({ roomId, status: 'pending', start: { $gt: t } }).sort({ start: 1 }).limit(1).toArray();
        const endMs = Math.min(t.getTime() + span(room, 'walkInMin'), later[0] ? later[0].start.getTime() : Infinity);
        if (endMs - t.getTime() < 10 * unit) return { granted: false, reason: 'room booked soon' };
        const walkIn = {
          roomId, userId: user._id, start: t, end: new Date(endMs), status: 'checked_in', checkInAt: t,
          source: 'walk_in', title: 'Walk-in', attendees: [user._id]
        };
        const { insertedId } = await bookings.insertOne(walkIn);
        L(roomId).lastPresenceAt = t;
        await logEvent(roomId, 'walk_in', 'node', { bookingId: String(insertedId) }, user._id);
        broadcast('booking', { roomId, bookingId: insertedId, status: 'checked_in', how: 'walk_in' });
        await step(room, false);
        return { granted: true, reason: `walk-in until ${hhmm(walkIn.end)}` };
      });
    }
  };
}

module.exports = { createEngine, DEFAULTS, dayKey };
