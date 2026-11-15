// RoomSense database schema (MongoDB). Only the server process (which also runs the MQTT broker) uses it.
// Each collection gets a $jsonSchema validator, so MongoDB itself rejects malformed documents.

const DAY = 24 * 3600;

const validators = {
  rooms: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'name', 'state', 'comfortC', 'ecoC', 'luxThreshold'],
      properties: {
        _id: { bsonType: 'string', description: 'room code, also used in MQTT topics, e.g. ME407' },
        name: { bsonType: 'string' },
        building: { bsonType: 'string' },
        capacity: { bsonType: 'int', minimum: 1 },
        state: { enum: ['FREE', 'RESERVED', 'OCCUPIED', 'OFFLINE'] },
        nodeStatus: { enum: ['online', 'offline'] },
        comfortC: { bsonType: 'number' },
        ecoC: { bsonType: 'number' },
        luxThreshold: { bsonType: 'number' },
        preheatMin: { bsonType: 'number', description: 'minutes before a booking when heating goes to comfort' },
        graceMin: { bsonType: 'number', description: 'minutes after the start before a booking becomes a no-show' },
        presenceTimeoutMin: { bsonType: 'number', description: 'minutes without motion before lights go off' },
        releaseTimeoutMin: { bsonType: 'number', description: 'minutes without motion before an occupied room is released' },
        walkInMin: { bsonType: 'number' },
        overrideMin: { bsonType: 'number', description: 'how long a manual web command pauses the automatic rule' },
        humidityMax: { bsonType: 'number' },
        gasMinOhms: { bsonType: 'number' },
        hasNode: { bsonType: 'bool', description: 'false for rooms known only from the timetable' },
        calendarFullSince: { bsonType: 'date', description: 'set when the room\'s own calendar was imported (all its classes known)' },
        lightPowerW: { bsonType: 'number' },
        heatingPowerW: { bsonType: 'number' },
        actuators: { bsonType: 'object', description: 'last state echoed by the node per actuator' },
        lastSeen: { bsonType: 'date' },
        gasReady: { bsonType: 'bool', description: 'false while the BME680 gas sensor is warming up (first 30 min)' }
      }
    }
  },
  users: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['name', 'role', 'rfidUidHash'],
      properties: {
        name: { bsonType: 'string' },
        email: { bsonType: 'string' },
        role: { enum: ['student', 'admin'] },
        rfidUidHash: { bsonType: 'string', description: 'SHA-256 of the badge UID; raw UIDs are never stored' },
        createdAt: { bsonType: 'date' }
      }
    }
  },
  bookings: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['roomId', 'start', 'end', 'status', 'source'],
      properties: {
        roomId: { bsonType: 'string' },
        userId: { bsonType: ['objectId', 'null'], description: 'null for timetabled classes' },
        attendees: { bsonType: 'array', items: { bsonType: 'objectId' }, description: 'everyone who badged into this booking or class' },
        source: { enum: ['user', 'walk_in', 'timetable'] },
        title: { bsonType: ['string', 'null'], description: 'course code for timetabled classes' },
        location: { bsonType: 'string', description: 'room name as written in the timetable, e.g. ME407.1' },
        createdAt: { bsonType: 'date' },
        start: { bsonType: 'date' },
        end: { bsonType: 'date' },
        status: { enum: ['pending', 'checked_in', 'no_show', 'released', 'completed', 'cancelled', 'unmonitored'], description: 'unmonitored = imported after it had started: counted in the schedule, never judged' },
        checkInAt: { bsonType: 'date' },
        endedAt: { bsonType: 'date' },
        endReason: { bsonType: 'string' }
      }
    }
  },
  events: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['ts', 'roomId', 'type', 'source'],
      properties: {
        ts: { bsonType: 'date' },
        roomId: { bsonType: 'string' },
        type: {
          enum: ['access_granted', 'access_denied', 'no_show', 'light_on', 'light_off', 'heating_on', 'heating_off',
            'fan_on', 'fan_off', 'override', 'node_online', 'node_offline', 'air_alert', 'bad_message',
            'check_in', 'walk_in', 'released', 'completed', 'timetable_import', 'not_monitored']
        },
        source: { enum: ['auto', 'web', 'node'] },
        userId: { bsonType: ['objectId', 'null'] },
        details: { bsonType: 'object' }
      }
    }
  },
  daily_stats: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['roomId', 'date'],
      properties: {
        roomId: { bsonType: 'string' },
        date: { bsonType: 'string', description: 'YYYY-MM-DD' },
        bookedMin: { bsonType: 'number' },
        occupiedMin: { bsonType: 'number', description: 'minutes with motion while the room was booked' },
        unbookedPresenceMin: { bsonType: 'number', description: 'minutes with motion while the room was free' },
        noShows: { bsonType: 'number' },
        lightsOnMin: { bsonType: 'number' },
        heatingOnMin: { bsonType: 'number' },
        fanOnMin: { bsonType: 'number' },
        estLightWhAvoided: { bsonType: 'number' },
        estHeatWhAvoided: { bsonType: 'number' }
      }
    }
  }
};

async function ensureCollection(db, name, options) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name, options);
  } else if (options.validator) {
    await db.command({ collMod: name, validator: options.validator });
  }
}

async function setupDatabase(db, defaultRoom) {
  // Raw sensor data: time-series collection, deleted automatically after 30 days (data minimisation).
  await ensureCollection(db, 'sensor_readings', {
    timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
    expireAfterSeconds: 30 * DAY
  });
  for (const name of Object.keys(validators)) {
    await ensureCollection(db, name, { validator: validators[name] });
  }
  await db.collection('users').createIndex({ rfidUidHash: 1 }, { unique: true });
  await db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
  await db.collection('bookings').createIndex({ roomId: 1, start: 1 });
  await db.collection('bookings').createIndex({ status: 1, start: 1 });
  // re-importing the same timetable updates sessions instead of duplicating them
  await db.collection('bookings').createIndex({ roomId: 1, start: 1, end: 1, source: 1 }, { unique: true, partialFilterExpression: { source: 'timetable' } });
  await db.collection('events').createIndex({ roomId: 1, ts: -1 });
  await db.collection('events').createIndex({ ts: 1 }, { expireAfterSeconds: 365 * DAY });
  await db.collection('daily_stats').createIndex({ roomId: 1, date: 1 }, { unique: true });

  // The demo room exists from the first start.
  await db.collection('rooms').updateOne(
    { _id: defaultRoom },
    {
      $setOnInsert: {
        name: `Study room ${defaultRoom}`, building: 'UT1 Capitole', capacity: 8,
        state: 'FREE', nodeStatus: 'offline',
        comfortC: 19.0, ecoC: 16.0, luxThreshold: 150.0,
        presenceTimeoutMin: 15, releaseTimeoutMin: 30,
        lightPowerW: 200.0, heatingPowerW: 1500.0, actuators: {}, hasNode: true
      }
    },
    { upsert: true }
  );
}

module.exports = { setupDatabase, validators };
