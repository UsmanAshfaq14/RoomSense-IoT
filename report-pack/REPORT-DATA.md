# RoomSense: data collected for the report

Collected on Tuesday 10 November 2026, 16:05 (Paris), from the running system (server, MongoDB, Raspberry Pi
node in ME407, dashboard). Times below are Paris time. Architecture, schema, topics, API, wiring and library
choices are in the READMEs of `roomsense-project.zip` (top level, `server/`, `node/`, `dashboard/`).

## 1. System state at collection time

| Item | Value |
|---|---|
| Server | up, normal clock (not demo), MQTT login required |
| MQTT clients connected | 1 (the ME407 node, logged in as `node-ME407`) |
| ME407 node | online, last message a few seconds before collection |
| ME407 state | OCCUPIED (walk-in by badge, 15:42–16:42) |
| Rooms known | 7 (ME401, ME402, ME403, ME404, ME405, ME407, ME410), all with their full ADE room calendar imported; only ME407 has a sensor node |
| Registered people | 3 (all students), badges stored as SHA-256 fingerprints |
| Bookings stored | 359: 358 timetable classes (337 upcoming, 21 "not monitored" because imported after they started) and 1 walk-in |
| Timetable data | 7 ADE room exports, 10 Nov 2026 to 4 Jan 2027 for most rooms (ME403 to 12 Feb, ME407 to 14 May) |

Live values in ME407 at collection: 26.5 °C, 53 % humidity, gas resistance 45–50 kΩ, 292 lux, 990 hPa,
motion detected. Heating off (room above the 19 °C comfort setpoint), lights off (292 lux is above the 150 lux
threshold), fan off (air good).

## 2. Live measurements, ME407, 15:19–16:05 (node running about 46 minutes)

| Measurement | Messages stored | Min | Max | Mean |
|---|---|---|---|---|
| Temperature (°C) | 50 | 26.15 | 26.59 | 26.43 |
| Humidity (%) | 50 | 51.9 | 55.5 | 53.8 |
| Pressure (hPa) | 50 | 989.6 | 990.0 | 989.8 |
| Gas resistance (Ω) | 50 | 2 668 | 52 683 | 33 730 |
| Light (lux) | 15 | 284.9 | 301.6 | 291.5 |
| Presence changes | 188 | 0 | 1 | (on/off events) |

### Traffic saved by "publish on change" (an RGESN point)

The node reads the BME680 every 5 s and the light sensor every 2 s, but publishes only when the value moves
enough (0.2 °C, 1 % humidity, 10 % gas, 15 % light) or every 5 minutes.

| Sensor | Reads in ~45 min | Messages sent | Reduction |
|---|---|---|---|
| Climate (BME680) | about 537 | 50 | about 91 % fewer messages and stored documents |
| Light (TSL2591, measured before the swap) | about 1 320 | 15 | about 99 % fewer |

(Reads = elapsed time / read period. Over a stable day the reduction is larger, since the 5-minute heartbeat
then dominates: at most 288 climate messages a day instead of 17 280 reads.)

## 3. Two findings from the real data (to fix on Thursday, worth a paragraph in the report)

**a. BME680 gas sensor warm-up causes a false air alert at start.** Gas resistance at node start was
2 668 Ω and rose steadily (3.9 k, 5.0 k, 6.4 k … 19 k after 70 s) to about 45 kΩ after 45 minutes. The
air-quality rule (alert below 10 kΩ) fired at 15:19:56, ten seconds after the node came online. This is the known
burn-in of the BME680's heated metal-oxide layer, not bad air. Planned fix: ignore gas for the first
30 minutes after the node starts. Fan only runs when the room is OCCUPIED, so no fan ran because of it.

**b. A PIR sensor sees motion, not people.** During the walk-in, with the IoT class working in the room, the statistics show
22 min booked but only 3.2 min "occupied" (14 %), because "occupied" counted only the instants when the PIR
reported motion; people sitting at laptops barely move. The room logic itself was not fooled (lights and
release use "motion in the last 15 / 30 minutes"), but the usage statistic under-counts. Planned fix: count a
minute as occupied when motion was seen in the last 15 minutes, the same rule the lights use. Report point:
presence sensing by PIR has limits; a CO2 sensor or a counting sensor would measure occupancy better.

## 4. Activity log today (excerpt, Paris time)

| Time | Event |
|---|---|
| 15:19 | Room node online |
| 15:19 | Air alert (BME680 warm-up, see 3a) |
| 15:20–15:23 | First timetable imports |
| 15:34 | Room node offline (Pi program stopped) |
| 15:36 | Room node online again |
| 15:39–15:40 | Timetable imports: the 7 ME4 room calendars |
| 15:42 | Badge Alexandra: walk-in booking until 16:42 |
| 16:03 | Room node online (restarted with its MQTT password) |

Event counts: 17 timetable imports, 4 node online, 1 node offline, 1 air alert, 1 walk-in, 1 access granted.

## 5. Use and energy statistics, ME407, 10 November

| Figure | Value |
|---|---|
| Booked | 22 min (the walk-in) |
| Motion during booked time | 3.2 min (14 %; see 3b) |
| Motion while the room was free | 6.6 min (people in the room before badging) |
| Lighting avoided (estimate) | 73 Wh: booked minutes with lights off, × 200 W |
| Heating avoided | 0 (no no-show or release today) |

## 6. Timetable analysis, ME4 floor (7 rooms, full ADE room calendars)

Open hours = 08:00–19:00, Monday–Friday = 55 h per room and week (385 h for the floor). "Scheduled" counts
only hours inside open hours; overlapping classes count once.

| Week | Scheduled | Empty open hours | Heating avoidable (est.) |
|---|---|---|---|
| 16–20 Nov | 44 % | 215 h | 68 kWh |
| 23–27 Nov | 42 % | 224 h | 71 kWh |
| 30 Nov–4 Dec | 38 % | 240 h | 76 kWh |
| 7–11 Dec | 17 % | 320 h | 101 kWh |
| 14–18 Dec | 8 % | 355 h | 112 kWh |
| **5 weeks** | **about 30 %** | **about 1 350 h** | **about 425 kWh** |

The week of 9 Nov is left out: the exports start on 10 Nov, so its Monday is missing for six rooms.

Per room, week of 16–20 Nov:

| Room | Classes | Scheduled | Share | Avoidable |
|---|---|---|---|---|
| ME401 | 9 | 21 h | 36 % | 11.0 kWh |
| ME402 | 14 | 31.5 h | 57 % | 7.4 kWh |
| ME403 | 15 | 33 h | 56 % | 7.6 kWh |
| ME404 | 11 | 27 h | 49 % | 8.8 kWh |
| ME405 | 8 | 18 h | 33 % | 11.7 kWh |
| ME407 | 10 | 18 h | 33 % | 11.7 kWh |
| ME410 | 10 | 24.5 h | 45 % | 9.6 kWh |

Timetabled hours per room over the whole export: ME401 73.5 h, ME402 123 h, ME403 216 h, ME404 109.5 h,
ME405 97.5 h, ME407 268 h, ME410 73.5 h.

Earlier single-room figure (ME407.1 calendar, 9 Nov to 18 Dec): 46 classes, 117 h scheduled of 330 open hours
(35.5 %); 9 of 30 weekdays with no class at all; three evenings run until 20:00, outside a fixed 08:00–19:00
heating schedule.

**How the saving estimate is computed** (state it in the report): heater power (1.5 kW, our assumption per
room) × 7 % per °C lowered (ADEME rule of thumb) × (comfort 19 °C − eco 16 °C) × empty open hours. It compares a
fixed schedule (comfort all open hours) with a timetable-driven one (eco when nothing is scheduled). An order of
magnitude, not a measurement; the hours come straight from the university timetable and are the solid result.

Privacy: teacher names in the ADE descriptions are never read or stored; only room, time and course title.

## 7. Automated tests (`test-results.txt`)

100 checks, all passing, run without MongoDB or a Pi:

- **Room logic with a controlled clock:** bookings and clashes, check-in by badge and by presence, no-show, release
  after 30 min without motion, walk-in (shortened before the next booking), check-out by badging again,
  light / heating / fan rules, manual override holding against the rules, air alert, daily statistics,
  settings validation, rooms without a sensor never judged.
- **Timetable import:** Outlook text and ADE `.ics` files, duplicates, multi-room events, folded lines, teacher
  names never stored, room-calendar detection, classes imported late kept as "not monitored".
- **Building view:** weekly figures, overlaps counted once, evening hours split, partial calendars excluded.
- **Measurements reset script:** dry run changes nothing; the apply step keeps users and upcoming classes.
- **End to end**, with the real Pi program on simulated pins and the real MQTT broker:
  - sensor messages stored;
  - malformed and out-of-range payloads refused and logged;
  - clients refused when they try to send actuator commands;
  - web commands reaching the node and echoed back;
  - unknown badge refused, then registered and granted; badge stored only as a hash;
  - MQTT login refused without a password and with a wrong one;
  - a node account unable to watch or publish for another room;
  - the node marked offline by its Last Will after being killed.

Also checked live today: the Pi's hardware MQTT self-test passes with the right password and is refused with a
wrong one.

## 8. Screenshots (`screenshots/`, light theme)

| File | Suggested caption |
|---|---|
| 01-room-ME407-live-values-and-controls | Room page: live sensor values and web-triggered actuators |
| 02-room-ME407-history-bookings-activity | Temperature and humidity history, bookings and activity log |
| 03-room-ME407-use-and-energy | Booked versus actually occupied time and estimated savings |
| 04-ME4-floor-week-9-nov | Floor view: scheduled share and avoidable heating, week of 9 Nov |
| 05 / 06-ME4-floor-week-16-nov | Floor view per room, week of 16 Nov |
| 07-all-rooms | All rooms: the sensor-equipped room and timetable-only rooms |
| 08-timetable-import | Timetable import with room filter; late imports shown as "not monitored" |
| 09-people-and-badges | Badge registration; badges stored only as SHA-256 fingerprints |

## 9. Still to collect on Thursday

- Fix the two findings in section 3, then collect a clean day of statistics.
- Evidence sessions: badge check-in on a booking, a no-show, a release after leaving, a walk-in.
- Robustness tests on the real hardware, screenshotted: Pi unplugged (Last Will), server restart, MongoDB
  stopped, Wi-Fi drop, a sensor disconnected, a forbidden MQTT message.
- `python3 check_hardware.py` output for each part (the earlier runs were not kept), plus photos of the wiring.

## Update 12 November: light sensor replaced
The TSL2591 stopped answering for good during the sensor-fault robustness test (its VIN wire was pulled while SDA/SCL
stayed connected; it vanished from the I2C bus even after a full power cut and new cables). It was replaced by a
Vishay VEML7700 (I2C 0x10), driven by our own small driver `node/veml7700.py` (smbus2 only; gain 1/8, 100 ms,
0.4608 lux per count, Vishay non-linearity correction above 1000 lux). The node accepts either sensor. Use
"VEML7700" for the light sensor in the hardware list from now on; the traffic figures above were measured with the
TSL2591 and stay valid (same publish-on-change rule). Lesson for the report: unplug I2C devices only with power off.

## Overnight run, 12 Nov 23:54 to 13 Nov 10:13
- Node up 10 h 19 min, no restart. Boot: campus address unreachable, hotspot (192.168.137.1) connected 10 s later.
- 0 broker drops, 0 standalone entries. One pigpio link loss at 00:01:01, rebuilt by the watchdog at 00:01:02.
- No node_offline event overnight; /api/health at 10:20: ok, database up, 1 MQTT client.
- Pi 10:13: 58 °C, 183/921 MiB used, load ~1.0, clock synchronised.
- Timeline 13 Nov: 15 motion periods 00:00-10:00 (7.0 h "occupied"), no booking, heating/lights/fan never on (22.7 °C > 19 °C comfort).
- 09:30 class (SB Internet of things): no motion in first 10 min, no_show at 09:40:01.
- Stats 13 Nov at ~10:20: booked 25 min, occupied 15 min, 1 no-show, est. 210 Wh heating + 83 Wh lighting avoided.
- Stats 12 Nov: booked 210 min, occupied 198 min (94 %), lights on 125 min.
- check_hardware.py all on 13 Nov ~10:15: 8/8 PASS (I2C 0x10 + 0x76; BME680 22.7-23.0 C, 55 %, 992 hPa, gas 20->61 kOhm; VEML7700 16-436 lux; PIR; RFID; LEDs; servo pigpio PWM; MQTT).
- Node off 2 min on the timeline at ~10:15 = stopped for the hardware check.
- PIR pulses overnight: 81. 47 lasted 4-5 s (normal HC-SR501 output), 34 lasted 1 s or less, almost all after 02:20 -> most likely electrical noise. With the 15-min hold: 6.9 h "occupied", 4.7 h of it from the short pulses only.
- Night series (Table 9 of the report): temperature 136 msgs 22.48-22.91 mean 22.65; humidity 136, 55.5-61.3, 58.0; pressure 136, 984.9-992.1, 988.2; gas after 00:24 119 msgs 36.7-45.7 kOhm mean 39.7; light 157, 0.5-91.2, 20.6; presence 162 changes.
- Reads vs messages: ~7 370 BME680 reads -> 136 messages (98 % fewer); ~18 500 light reads -> 157 (99 % fewer). Mostly 5-min heartbeats.
- Story: lamp 00:19-01:47 (~85 lux), humidity +3 pts at 01:43, temp 22.9 -> 22.5 C, pressure 985 -> 992 hPa, daylight from ~08:00.
- Figure: figures/overnight-12-13nov.png (made by overnight/fig.py from overnight/series.json).
