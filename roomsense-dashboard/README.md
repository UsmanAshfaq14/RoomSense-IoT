# RoomSense dashboard (Angular 19)

Live view and control of RoomSense rooms. Talks only to the RoomSense server API on http://localhost:3000.

## Run

For use and for the demo, the server delivers the dashboard itself (one process, one port):

1. Here, once after each change: `npm install` (first time only), then `npm run build`.
2. In the server folder: `npm start` (or `npm run demo`).
3. Open http://localhost:3000

While developing, `npm start` here runs the Angular dev server with live reload on http://localhost:4200
(the server must run too; the page then calls the API on port 3000).

## Weight

Pages are loaded only when visited. First load: about 298 kB of JavaScript and CSS, 85 kB once compressed;
the room page and its chart library (about 62 kB compressed) only when it is opened. The build fails above
500 kB initial (warning at 350 kB, `angular.json`). Files carry a content hash and are cached by the browser
for a year; no web fonts, no images, no third-party requests.

## Pages

- **ME407**: a live strip saying what the room is waiting for, with a countdown (class starts in 8:52, no-show in
  4:10, released if nobody moves for 12 min; in demo mode the seconds tick as fast as the logic), live sensor values,
  manual control of heating / lights / fan (web-triggered actuators), the day's timeline (timetable, bookings,
  occupied, heating, lights, fan and node-offline lanes on one axis, any day), history charts, bookings, activity
  log, use and energy statistics, room settings.
- **All rooms**: every room, including rooms known only from the timetable.
- **ME4 floor**: one teaching week for every room of the floor: scheduled share of open hours, empty hours and the
  heating a schedule-driven setpoint would avoid. Only rooms whose own calendar was imported are counted.
  Below it, the term at a glance: the scheduled share for every week of the imported timetable; click a week to open it.
- **People**: register badges (tap a new badge on the reader, it appears in the form).
- **Timetable**: import an .ics file (ADE room or group export) or the pasted invitation text, filtered by room prefix.

## Libraries

- Angular 19 (required by the course): components, routing, HttpClient, forms.
- Chart.js 4: the history and statistics charts. Only the chart parts used are registered, to keep the download small.
- No web fonts, no CSS framework: system fonts and one stylesheet.

Live updates use the browser's built-in EventSource (server-sent events from `/api/stream`), so no extra library.
