import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { Subscription } from 'rxjs';
import { ApiService, Booking, DayStats, DayTimeline, RoomClock, RoomDetail, RoomEvent, User, errorText, fmtAgo, fmtDay, fmtTime, fmtWhen } from './api.service';
import { LiveService } from './live.service';
import { Bars, ChartComponent, Series } from './chart.component';
import { describeEvent } from './describe';
import { DayTimelineComponent } from './timeline.component';

const parisDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);
type StripItem = { text: string; count?: string; at?: string; tone?: 'warn' | 'ok' };
type ChartKind = 'climate' | 'light' | 'presence' | 'air';
const COLORS = { temp: '#d9480f', hum: '#1c7ed6', light: '#e8a400', presence: '#2b8a3e', gas: '#7048e8', limit: '#868e96', booked: '#748ffc', occupied: '#2b8a3e' };

@Component({
  selector: 'app-room',
  imports: [ChartComponent, DayTimelineComponent, FormsModule, RouterLink, DecimalPipe],
  templateUrl: './room.component.html'
})
export class RoomComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private live = inject(LiveService);
  private route = inject(ActivatedRoute);
  private subs: Subscription[] = [];
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private clock?: ReturnType<typeof setInterval>;

  readonly fmtTime = fmtTime; readonly fmtDay = fmtDay; readonly fmtAgo = fmtAgo; readonly fmtWhen = fmtWhen; readonly describe = describeEvent;
  readonly id = signal('');
  readonly room = signal<RoomDetail | null>(null);
  readonly bookings = signal<Booking[]>([]);
  readonly events = signal<RoomEvent[]>([]);
  readonly users = signal<User[]>([]);
  readonly stats = signal<DayStats[]>([]);
  readonly statsNote = signal('');
  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal('');
  readonly chartKind = signal<ChartKind>('climate');
  readonly hours = signal(6);
  readonly series = signal<Series[]>([]);
  readonly now = signal(Date.now());
  // Climate and light are re-sent at least every 5 minutes even when nothing changes (heartbeat), so a value
  // older than 6 minutes while the node is online means that sensor stopped answering (unplugged, loose wire).
  silent(reading?: { ts: string }): string | null {
    const r = this.room();
    if (!reading || !r || r.nodeStatus !== 'online') return null;
    const min = (this.now() - Date.parse(reading.ts)) / 60000;
    return min > 6 ? `no reading for ${Math.round(min)} min: check the sensor` : null;
  }
  readonly settingsOpen = signal(false);
  // form errors shown next to the form and linked to the field concerned (RGAA 11.10)
  readonly bookError = signal('');
  readonly bookInvalid = signal<string[]>([]);
  readonly settingsError = signal('');
  readonly settingsInvalid = signal('');
  readonly chartLabel = computed(() => {
    const what = { climate: 'Temperature and humidity', light: 'Light level and lights-on threshold', presence: 'Motion detected', air: 'Air quality and humidity' }[this.chartKind()];
    return `${what}, last ${this.hours()} h`;
  });
  // which of On / Off / Auto is in force, for aria-pressed
  mode(name: string): 'on' | 'off' | 'auto' {
    if (!this.overrideUntil(name)) return 'auto';
    return this.room()?.actuators?.[name]?.on ? 'on' : 'off';
  }
  readonly timeline = signal<DayTimeline | null>(null);
  readonly tlDate = signal(parisDay(new Date()));
  readonly isToday = computed(() => this.tlDate() === parisDay(new Date(this.now())));

  // ---- live strip: what the room is waiting for, with a countdown ----
  private skew = 0;            // server clock minus browser clock, so countdowns follow the server's time
  private reloadAt = 0;        // when the next deadline passes, reload once to show the new state
  readonly strip = computed((): { head: string; tone: 'free' | 'reserved' | 'occupied' | 'offline'; items: StripItem[] } | null => {
    const r = this.room(); const c = r?.clock;
    if (!r || !c || c.mode === 'timetable') return null;
    const t = this.now() + this.skew;
    const left = (iso?: string | null) => (iso ? Date.parse(iso) - t : NaN);
    const label = (b: Booking | null) => (b ? this.bookingLabel(b) : 'booking');
    const items: StripItem[] = [];
    let head = ''; let tone: 'free' | 'reserved' | 'occupied' | 'offline' = 'free';
    if (r.nodeStatus !== 'online') {
      return { head: 'Room node offline', tone: 'offline', items: [{ text: 'Nothing is judged while the room cannot be seen: no no-show, no release.' }] };
    }
    if (c.mode === 'in_use') {
      tone = 'occupied'; head = `In use · ${label(r.currentBooking)}`;
      items.push({ text: 'ends in', count: this.countdown(left(c.endsAt)), at: this.fmtTime(c.endsAt!) });
      if (c.motionNow) items.push({ text: 'motion now, the room stays booked', tone: 'ok' });
      else if (c.releaseAt) items.push({ text: 'released if nobody moves for', count: this.countdown(left(c.releaseAt)), at: this.fmtTime(c.releaseAt), tone: 'warn' });
      if (c.attendees) items.push({ text: `${c.attendees} badged in` });
    } else if (c.mode === 'waiting') {
      tone = 'reserved'; head = `Waiting for check-in · ${label(r.nextBooking)}`;
      if (c.noShowAt) items.push({ text: 'no-show in', count: this.countdown(left(c.noShowAt)), at: this.fmtTime(c.noShowAt), tone: 'warn' });
      else items.push({ text: 'not watched from its start, so it will not be called a no-show' });
      items.push({ text: r.nextBooking?.source === 'timetable' ? 'any badge or motion checks it in' : `${r.nextBooking?.userName || 'the booker'}'s badge checks it in` });
    } else if (c.mode === 'booked') {
      const preheating = left(c.preheatAt) <= 0;
      tone = preheating ? 'reserved' : 'free';
      head = preheating ? `Reserved · ${label(r.nextBooking)}` : `Free · next: ${label(r.nextBooking)}`;
      items.push({ text: 'starts in', count: this.countdown(left(c.startsAt)), at: this.fmtTime(c.startsAt!) });
      items.push(preheating ? { text: `heating to ${r.comfortC} °C comfort`, tone: 'ok' } : { text: `heating to comfort ${this.fmtTime(c.preheatAt!)}` });
      if (c.noShowAt) items.push({ text: `no-show at ${this.fmtTime(c.noShowAt)} if nobody comes` });
    } else {
      head = 'Free · nothing booked'; items.push({ text: `heating held at ${r.ecoC} °C eco; tap a badge to walk in` });
    }
    return { head, tone, items };
  });
  private countdown(ms: number) {
    if (!isFinite(ms)) return '–';
    if (ms <= 0) return 'now';
    const s = Math.ceil(ms / 1000);
    if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;
    if (s >= 600) return `${Math.round(s / 60)} min`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  private nextDeadline(c?: RoomClock) {
    if (!c) return 0;
    const t = Date.parse(c.serverNow);
    const times = [c.startsAt, c.endsAt, c.preheatAt, c.noShowAt, c.releaseAt].filter((x): x is string => !!x).map(Date.parse).filter((x) => x > t);
    return times.length ? Math.min(...times) - this.skew : 0;
  }

  readonly actuatorList = [
    { name: 'heating', label: 'Heating (red LED)' },
    { name: 'light', label: 'Room lights (yellow LED)' },
    { name: 'fan', label: 'Ventilation fan (FS90R)' }
  ];
  bookingForm = { userId: '', date: '', time: '', duration: 60, title: '' };
  settingsForm: Record<string, number> = {};
  readonly settingFields = [
    { key: 'comfortC', label: 'Comfort temperature', unit: '°C', step: 0.5 },
    { key: 'ecoC', label: 'Eco temperature', unit: '°C', step: 0.5 },
    { key: 'luxThreshold', label: 'Lights on below', unit: 'lux', step: 10 },
    { key: 'preheatMin', label: 'Pre-heat before a booking', unit: 'min', step: 1 },
    { key: 'graceMin', label: 'No-show after', unit: 'min', step: 1 },
    { key: 'presenceTimeoutMin', label: 'Lights off after no motion', unit: 'min', step: 1 },
    { key: 'releaseTimeoutMin', label: 'Release room after no motion', unit: 'min', step: 1 },
    { key: 'humidityMax', label: 'Ventilate above humidity', unit: '%', step: 1 }
  ];

  readonly upcoming = computed(() => this.bookings().filter((b) => b.status === 'pending' || b.status === 'checked_in'));
  readonly past = computed(() => this.bookings().filter((b) => b.status !== 'pending' && b.status !== 'checked_in').slice(-8).reverse());
  readonly statBars = computed<Bars | null>(() => {
    const days = [...this.stats()].reverse();
    if (!days.length) return null;
    return {
      labels: days.map((d) => d.date.slice(5)),
      sets: [
        { label: 'Booked (h)', values: days.map((d) => +((d.bookedMin || 0) / 60).toFixed(2)), color: COLORS.booked },
        { label: 'Actually occupied (h)', values: days.map((d) => +((d.occupiedMin || 0) / 60).toFixed(2)), color: COLORS.occupied }
      ]
    };
  });
  readonly totals = computed(() => {
    const t = { booked: 0, occupied: 0, noShows: 0, lightWh: 0, heatWh: 0 };
    for (const d of this.stats()) {
      t.booked += d.bookedMin || 0; t.occupied += d.occupiedMin || 0; t.noShows += d.noShows || 0;
      t.lightWh += d.estLightWhAvoided || 0; t.heatWh += d.estHeatWhAvoided || 0;
    }
    return t;
  });

  ngOnInit() {
    this.subs.push(this.route.paramMap.subscribe((p) => {
      this.id.set(p.get('id') || 'ME407');
      this.resetBookingForm();
      this.loadAll();
    }));
    this.subs.push(this.live.events$.subscribe((e) => {
      if (!e.data || e.data.roomId !== this.id()) return;
      if (e.type === 'reading') this.applyReading(e.data);
      if (e.type === 'access') this.flash(`Badge ${e.data.user || 'unknown'}: ${e.data.granted ? 'granted' : 'refused'} (${e.data.reason})`);
      if (e.type !== 'reading') this.scheduleRefresh();
    }));
    this.clock = setInterval(() => {
      this.now.set(Date.now());
      if (this.reloadAt && Date.now() > this.reloadAt + 1500) { this.reloadAt = 0; this.scheduleRefresh(); }
    }, 1000);
  }

  ngOnDestroy() {
    this.subs.forEach((s) => s.unsubscribe());
    clearTimeout(this.refreshTimer);
    clearInterval(this.clock);
  }

  private async loadAll() {
    await Promise.all([this.loadRoom(), this.loadBookings(), this.loadEvents(), this.loadStats(), this.loadUsers(), this.loadTimeline()]);
    await this.loadChart();
  }
  private async loadRoom() {
    try {
      const r = await this.api.room(this.id());
      if (r.clock) this.skew = Date.parse(r.clock.serverNow) - Date.now();
      this.room.set(r);
      this.reloadAt = this.nextDeadline(r.clock);
      this.error.set('');
      if (!this.settingsOpen()) {
        this.settingsForm = Object.fromEntries(this.settingFields.map((f) => [f.key, (r as any)[f.key] ?? r.settingsDefaults[f.key]]));
      }
    } catch (err) { this.error.set(errorText(err)); }
  }
  private async loadBookings() {
    try {
      const from = new Date(Date.now() - 24 * 3600e3); const to = new Date(Date.now() + 14 * 24 * 3600e3);
      this.bookings.set(await this.api.bookings(this.id(), from, to));
    } catch { /* shown by loadRoom */ }
  }
  private async loadTimeline() { try { this.timeline.set(await this.api.timeline(this.id(), this.tlDate())); } catch { /* idem */ } }
  shiftDay(days: number) {
    const [y, m, d] = this.tlDate().split('-').map(Number);
    this.tlDate.set(days === 0 ? parisDay(new Date()) : parisDay(new Date(Date.UTC(y, m - 1, d + days, 12))));
    this.loadTimeline();
  }
  tlDateLabel() {
    const [y, m, d] = this.tlDate().split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  private async loadEvents() { try { this.events.set(await this.api.events(this.id(), 30)); } catch { /* idem */ } }
  private async loadUsers() { try { this.users.set(await this.api.users()); } catch { /* idem */ } }
  private async loadStats() {
    try { const s = await this.api.stats(this.id(), 7); this.stats.set(s.days); this.statsNote.set(s.note); } catch { /* idem */ }
  }

  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.loadRoom(); this.loadBookings(); this.loadEvents(); if (this.isToday()) this.loadTimeline(); }, 300);
  }

  private applyReading(data: { roomId?: string; ts: string; values: Record<string, number>; gasReady?: boolean }) {
    const r = this.room();
    if (!r || (data.roomId && data.roomId !== r._id)) return;
    const latest = { ...r.latest };
    for (const [type, value] of Object.entries(data.values)) (latest as any)[type] = { value, ts: data.ts };
    this.room.set({ ...r, latest, ...(data.gasReady !== undefined ? { gasReady: data.gasReady } : {}) });
    const x = new Date(data.ts).getTime();
    const map: Record<string, string> = { temperature: 'Temperature (°C)', humidity: 'Humidity (%)', light: 'Light (lux)', presence: 'Motion', gas: 'Air quality (kΩ)' };
    this.series.update((list) => list.map((s) => {
      const entry = Object.entries(map).find(([, label]) => label === s.label);
      if (!entry || data.values[entry[0]] === undefined) return s;
      const y = entry[0] === 'gas' ? data.values[entry[0]] / 1000 : data.values[entry[0]];
      return { ...s, points: [...s.points, { x, y }] };
    }));
  }

  async loadChart() {
    const id = this.id(); const h = this.hours();
    const pts = async (type: string, scale = 1) => (await this.api.readings(id, type, h)).map((p) => ({ x: new Date(p.ts).getTime(), y: p.value * scale }));
    try {
      const kind = this.chartKind();
      if (kind === 'climate') {
        this.series.set([
          { label: 'Temperature (°C)', points: await pts('temperature'), color: COLORS.temp },
          { label: 'Humidity (%)', points: await pts('humidity'), color: COLORS.hum, axis: 'y2' }
        ]);
      } else if (kind === 'light') {
        const light = await pts('light');
        const thr = this.room()?.luxThreshold ?? 150;
        const edge = light.length ? [{ x: light[0].x, y: thr }, { x: light[light.length - 1].x, y: thr }] : [];
        this.series.set([
          { label: 'Light (lux)', points: light, color: COLORS.light, fill: true },
          { label: 'Lights-on threshold', points: edge, color: COLORS.limit }
        ]);
      } else if (kind === 'presence') {
        this.series.set([{ label: 'Motion', points: await pts('presence'), color: COLORS.presence, stepped: true, fill: true }]);
      } else {
        this.series.set([
          { label: 'Air quality (kΩ)', points: await pts('gas', 0.001), color: COLORS.gas },
          { label: 'Humidity (%)', points: await pts('humidity'), color: COLORS.hum, axis: 'y2' }
        ]);
      }
    } catch (err) { this.error.set(errorText(err)); }
  }
  setChart(kind: ChartKind) { this.chartKind.set(kind); this.loadChart(); }
  setHours(h: number) { this.hours.set(h); this.loadChart(); }

  actuatorState(name: string) {
    const a = this.room()?.actuators?.[name];
    if (!a) return 'no report yet';
    if (name === 'light') return a.on ? `on${a.level !== undefined && a.level < 1 ? ` (${Math.round(a.level * 100)} %)` : ''}` : 'off';
    if (name === 'fan') return a.on ? 'running' : 'stopped';
    return a.on ? 'on' : 'off';
  }
  overrideUntil(name: string) {
    const o = this.room()?.overrides?.[name];
    return o && new Date(o.until).getTime() > this.now() ? fmtTime(o.until) : null;
  }
  async setActuator(name: string, mode: 'on' | 'off' | 'auto') {
    this.busy.set(name);
    const body = mode === 'auto' ? { mode: 'auto' } : name === 'light' ? { on: mode === 'on', level: 1 } : name === 'fan' ? { on: mode === 'on', speed: 0.9 } : { on: mode === 'on' };
    try {
      await this.api.actuator(this.id(), name, body);
      this.flash(mode === 'auto' ? `${name}: back to automatic` : `${name}: ${mode} (manual for ${this.room()?.settingsDefaults?.['overrideMin'] ?? 30} min)`);
      setTimeout(() => this.loadRoom(), 600);
    } catch (err) { this.flash(errorText(err)); } finally { this.busy.set(''); }
  }

  private resetBookingForm() {
    const d = new Date(Date.now() + 30 * 60e3);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    this.bookingForm = { ...this.bookingForm, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, title: '' };
  }
  async book() {
    const f = this.bookingForm;
    this.bookError.set(''); this.bookInvalid.set([]);
    if (!f.userId) { this.bookError.set('Choose who the booking is for.'); this.bookInvalid.set(['user']); return; }
    const start = new Date(`${f.date}T${f.time}`);
    const end = new Date(start.getTime() + f.duration * 60e3);
    try {
      await this.api.book({ roomId: this.id(), userId: f.userId, start: start.toISOString(), end: end.toISOString(), title: f.title || undefined });
      this.flash(`Booked ${fmtDay(start)} ${fmtTime(start)}–${fmtTime(end)}`);
      this.resetBookingForm();
      this.loadBookings(); this.loadRoom();
    } catch (err) {
      const text = errorText(err);
      this.bookError.set(text);
      // the server's messages say which part is wrong: who, or when
      this.bookInvalid.set(/user/i.test(text) ? ['user'] : /time|start|end|booked|hour|over/i.test(text) ? ['time'] : []);
    }
  }
  async cancel(b: Booking) {
    try { await this.api.cancel(b._id); this.flash('Booking cancelled'); this.loadBookings(); this.loadRoom(); } catch (err) { this.flash(errorText(err)); }
  }

  async saveSettings() {
    try {
      this.settingsError.set(''); this.settingsInvalid.set('');
      await this.api.settings(this.id(), this.settingsForm);
      this.flash('Settings saved'); this.settingsOpen.set(false); this.loadRoom();
    } catch (err) {
      const text = errorText(err);
      this.settingsError.set(text);
      this.settingsInvalid.set(this.settingFields.find((f) => text.includes(f.key))?.key ?? '');
    }
  }

  bookingLabel(b: Booking) {
    if (b.source === 'timetable') return b.title ? `Class ${b.title}` : 'Timetabled class';
    if (b.source === 'walk_in') return `Walk-in · ${b.userName || ''}`;
    return `${b.userName || 'Unknown'}${b.title ? ` · ${b.title}` : ''}`;
  }

  // A notice stays until it is closed or replaced by the next one: no time limit to read it (RGAA 13.1).
  private flash(text: string) { this.notice.set(text); }
}
