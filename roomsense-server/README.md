# RoomSense server

One Node.js process that is at the same time:

- the **MQTT broker** (Aedes) the Raspberry Pi nodes connect to,
- the **only component that talks to MongoDB**,
- the **room logic** (bookings, check-in, no-show, release, walk-in, heating / light / fan rules),
- the **REST API + live stream** used by the Angular dashboard.

```
 Raspberry Pi (node)  --MQTT 1883-->  RoomSense server  --driver-->  MongoDB
   sensors, LEDs, fan                 broker + logic + API
                                           ^ HTTP 3000 (REST + server-sent events)
                                           |
                                      Angular dashboard (http://localhost:4200)
```

The Pi never touches the database or the API: it only publishes and subscribes on MQTT.

## Requirements

- Node.js 20 or later (tested on 22)
- MongoDB 6 or later running locally (`mongodb://127.0.0.1:27017`); time-series collections need 5.0+

## Install and run

```
npm install
node scripts/mqtt-user.js add node-ME407 --room ME407     # once: MQTT account for the Pi (see below)
npm start                                                 # normal clock
npm run demo-setup                                        # once before a demo: copy users, rooms, classes to roomsense_demo
npm run demo                                              # demo clock (one room-logic minute = one second) on roomsense_demo
```

The demo runs on its own database, `roomsense_demo`, so a rehearsal never mixes with the real measurements.
`npm run demo-setup` refills it from `roomsense` (users and badges, rooms and settings, timetable classes, all
still to come) and leaves the demo room without a class today, so it starts FREE. Run it again before each rehearsal.

Check it is up: http://localhost:3000/api/health

If the dashboard has been built (`npm run build` in the dashboard folder), the server also delivers it:
open http://localhost:3000. One process for the broker, the API and the web pages.

At start the server creates the collections, their validators and indexes, and the room `ME407` if missing.
It prints whether MQTT login is on, and refuses to start if MongoDB cannot be reached.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `MONGO_URL` | `mongodb://127.0.0.1:27017` | MongoDB connection |
| `HTTP_HOST` | `127.0.0.1` | the web API has no login, so by default it answers only on this laptop; `0.0.0.0` opens it to the network (to show the dashboard on a phone). The MQTT broker always listens on the network, behind its accounts. |
| `DB_NAME` | `roomsense` (`roomsense_demo` in demo mode) | database name |
| `MQTT_PORT` | `1883` | broker port (listens on all interfaces, so the Pi can reach it) |
| `HTTP_PORT` | `3000` | REST API port |
| `ROOM` | `ME407` | room with a sensor node, created at start |
| `DEMO` | off | `DEMO=1` is the same as `npm run demo` |
| `MQTT_USERS_FILE` | `./mqtt-users.json` | MQTT accounts |

## MQTT accounts

Each Pi logs in with its own account. A node account can publish and subscribe **only under its own room**
(`campus/ME407/...`), so one Pi cannot send readings or badges for another room. Nobody but the server may
publish actuator commands (`actuator/*/set`) or badge results (`rfid/result`).

```
node scripts/mqtt-user.js add node-ME407 --room ME407    # prints the password once
node scripts/mqtt-user.js add admin --admin              # optional: debugging tool (e.g. MQTT Explorer), sees every room
node scripts/mqtt-user.js list
node scripts/mqtt-user.js remove node-ME407
```

Restart the server after a change. Passwords are stored only as salted scrypt hashes in `mqtt-users.json`
(kept out of git). On the Pi, put the password in `mqtt-password.txt` next to `roomsense_node.py`.

With no account at all the broker stays open and the server prints a warning: handy for a first test, not
for the demo. Limitation: port 1883 is plain MQTT, so the password crosses the local network unencrypted;
TLS on port 8883 would be the next step for a real building.

## MQTT topics

Base topic `campus/<room>`.

| Direction | Topic | Payload |
|---|---|---|
| Pi -> server | `sensor/presence` | `{"ts", "presence"}` on change |
| Pi -> server | `sensor/climate` | `{"ts", "celsius", "humidity", "hPa", "gasOhms"}` on change or every 5 min |
| Pi -> server | `sensor/light` | `{"ts", "lux", "saturated"}` on change or every 5 min |
| Pi -> server | `sensor/rfid` | `{"ts", "uid"}` per badge, QoS 1 |
| Pi -> server | `node/status` | `online` / `offline` (retained; `offline` is the Last Will) |
| Pi -> server | `actuator/<name>/state` | echo of a command once applied |
| server -> Pi | `actuator/{status,heating,light,fan}/set` | command, retained, QoS 1 |
| server -> Pi | `rfid/result` | `{"granted", "reason"}` |

Every incoming payload is validated (type, range); a bad one is refused and logged as a `bad_message` event.

## Database (MongoDB)

Each collection has a `$jsonSchema` validator (see `db.js`), so MongoDB itself rejects malformed documents.

| Collection | Holds | Lifetime |
|---|---|---|
| `rooms` | one per room: state, settings, node status, last actuator states | kept |
| `users` | name, role, badge as a SHA-256 hash (never the raw UID) | kept |
| `bookings` | user bookings, walk-ins and timetable classes; status pending / checked_in / no_show / released / completed / cancelled / unmonitored | kept |
| `sensor_readings` | time-series collection, one value per document (`meta.roomId`, `meta.type`) | 30 days (TTL) |
| `events` | activity log: access, no-shows, actuator changes, imports, bad messages | 365 days (TTL) |
| `daily_stats` | per room and day: booked, occupied, lights / heating / fan minutes, estimated savings | kept |

## REST API

All under `http://localhost:3000/api`. Errors come back as `{"error": "..."}` with 400 / 404 / 409.

| Method | Path | Does |
|---|---|---|
| GET | `/health` | server up, number of MQTT clients, demo mode |
| GET | `/rooms` | all rooms |
| GET | `/rooms/:id` | one room: latest readings, overrides, current and next booking, and `clock`: the deadlines the logic is counting towards (start, no-show, release) |
| GET | `/rooms/:id/timeline?date=YYYY-MM-DD` | one day on one time axis: scheduled, booked, occupied, heating, lights, fan, node offline |
| PUT | `/rooms/:id/settings` | change setpoints and timings (ranges checked) |
| GET | `/rooms/:id/readings?type=temperature&hours=24` | history of one measurement |
| GET | `/rooms/:id/stats?days=7` | daily use and energy figures |
| POST | `/rooms/:id/actuators/:name` | web command, e.g. `{"on": true}`; `{"mode": "auto"}` hands back to the rules |
| GET | `/building?prefix=ME4&date=YYYY-MM-DD` | one teaching week for every room of a floor |
| GET | `/building/trend?prefix=ME4` | the week totals for every week of the imported timetable |
| GET / POST | `/bookings` | list (`roomId`, `from`, `to`) / create (refused for a room without a node) |
| DELETE | `/bookings/:id` | cancel |
| POST | `/timetable/import?rooms=ME4` | import an ADE `.ics` file or pasted Outlook invitation text |
| GET | `/events?roomId=&limit=` | activity log |
| GET / POST | `/users` | list / register a badge |
| GET | `/rfid/last-unknown` | last unregistered badge seen (in memory only), to register it |
| GET | `/stream` | server-sent events: readings, room states, bookings, access |

## Room logic in one paragraph

A room is FREE, RESERVED (a booking starts within 15 min: heating goes to comfort) or OCCUPIED (checked in by
the booker's badge, any registered badge or motion for a timetabled class). Nobody within 10 min of the start:
no-show, back to FREE and eco. No motion for 30 min while OCCUPIED: released. A badge on a free room books it
on the spot (walk-in, up to 60 min). There is no door lock, so a badge says who is there: once a class or
booking is running, any registered badge joins it (listed as an attendee); only the booker's badge checks out,
and nobody can start someone else's booking before the booker arrives. Unknown badges are refused, and a badge
read more than 60 s ago (queued during a network outage) is ignored. A node that drops off and is back within 2 minutes (a Wi-Fi blip)
counts as watched all along, so the booking in progress can still be judged; a longer outage cannot. Lights: on when occupied, someone moved in the last 15 min and it is darker
than the threshold. Fan: on when occupied and humidity or gas says the air is bad. A web command overrides a
rule for 30 min. Rooms known only from the timetable (no sensor) just follow their schedule and are never judged.

## Scripts

| Command | Does |
|---|---|
| `npm test` | 134 checks: room logic with a controlled clock, then an end-to-end run with the real Pi program (mock pins) and MQTT logins. Needs no MongoDB; the end-to-end part needs `python3` with `paho-mqtt` and `gpiozero` and the node folder next to this one (or `NODE_SCRIPT=path/to/roomsense_node.py`). |
| `npm run demo-setup` | refills the separate demo database from the real one (above) |
| `npm run reset-stats` | shows what a reset would remove; `npm run reset-stats -- --yes` clears statistics, activity log, readings and people's bookings (keeps users, rooms, settings, upcoming classes). Stop the server first. |
| `node scripts/mqtt-user.js ...` | MQTT accounts (above) |
| `node scripts/robustness-mqtt.js --password <admin password>` | live robustness checks against the running broker: refused logins, bad payloads refused and logged, a client trying to send a command is cut off, per-room rights (add `--node-password`). Needs an admin account (`node scripts/mqtt-user.js add tester --admin`). |

## Libraries

| Library | Why this one |
|---|---|
| `aedes` 0.51 | MQTT broker that runs inside our Node process, so the broker and the database writer are one component, as required. Hooks (`authenticate`, `authorizePublish`, `authorizeSubscribe`) give per-room rights. Mosquitto would be a second process with no direct link to our logic. |
| `express` 4 | REST API and server-sent events, the framework of the course; also serves the built dashboard. |
| `compression` 1.8 | gzip for the dashboard files and large API answers (about a third of the size on the wire); skipped for the live stream. The standard Express middleware. |
| `mongodb` 6 | official driver: validators, time-series collections and TTL indexes used directly. No ODM (Mongoose): the schema lives in MongoDB's own validators, so there is one source of truth. |
| `mqtt` 5 (dev only) | test client in `test/e2e.js`. |

Built-in Node modules cover the rest: `crypto` (badge hashes, scrypt passwords), `net` (broker socket),
`Intl` (Europe/Paris times for the timetable, no date library).

## Troubleshooting

- **Pi says "broker refused the connection: Bad user name or password"**: the account is missing or the
  password in `mqtt-password.txt` does not match; create it again with `node scripts/mqtt-user.js add ...`
  and restart the server.
- **Pi cannot connect at all**: the laptop IP changed (university Wi-Fi). `ipconfig` on the laptop, then
  start the node with `--broker <new IP>`; Windows firewall must allow port 1883.
- **`Cannot reach MongoDB`** at start: start the MongoDB service. If MongoDB stops while the server runs, the
  server keeps going: `/api/health` says `"database":"down"`, the API answers 503, readings are dropped (not
  queued), a badge gets "system temporarily unavailable", and everything resumes on its own when MongoDB is back.
- **mongosh in PowerShell**: inside `--eval '...'`, double every single quote, e.g. `[''ME208'']`.
