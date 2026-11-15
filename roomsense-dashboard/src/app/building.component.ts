import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService, Building, BuildingRoom, TrendWeek, errorText, fmtTime } from './api.service';
import { LiveService } from './live.service';

// Timeline span drawn for each day: 07:00 to 21:00, with the building's open hours shaded.
const FROM = 7;
const TO = 21;
const TZ = 'Europe/Paris';
const hourOf = (iso: string) => {
  const [h, m] = new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return h + m / 60;
};
const ymd = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: TZ });

@Component({
  selector: 'app-building',
  imports: [FormsModule, RouterLink],
  template: `
    <section class="page-head">
      <div>
        <h1>{{ prefix || 'All' }} floor</h1>
        <p class="sub">How much of the teaching week each room is actually scheduled, from the timetable and bookings. No sensor needed.</p>
      </div>
      <div class="week-nav">
        <label class="inline">Rooms starting with <input name="prefix" [(ngModel)]="prefix" (change)="load()" size="5"></label>
        <div class="seg" role="group" aria-label="Week">
          <button type="button" (click)="shift(-7)" aria-label="Previous week">‹</button>
          <button type="button" (click)="today()" [class.on]="isThisWeek()" [attr.aria-pressed]="isThisWeek()" [attr.aria-label]="'This week (showing ' + weekLabel() + ')'">{{ weekLabel() }}</button>
          <button type="button" (click)="shift(7)" aria-label="Next week">›</button>
        </div>
      </div>
    </section>
    @if (error()) { <p class="banner error" role="alert">{{ error() }}</p> }

    @if (data(); as b) {
      <section class="tiles" aria-label="Week totals">
        <div class="tile"><div class="tile-label">Scheduled</div>
          <div class="tile-value">{{ b.totals.sharePct ?? '—' }}<small>%</small></div>
          <div class="tile-sub">of open hours ({{ b.week.openFrom }}–{{ b.week.openTo }} h, Mon–Fri)</div></div>
        <div class="tile"><div class="tile-label">Empty open hours</div>
          <div class="tile-value">{{ b.totals.emptyH }}<small>h</small></div>
          <div class="tile-sub">heated for nobody on a fixed schedule</div></div>
        <div class="tile"><div class="tile-label">Heating avoidable</div>
          <div class="tile-value">{{ b.totals.estKWhAvoidable }}<small>kWh</small></div>
          <div class="tile-sub">estimate, eco setpoint when empty</div></div>
        <div class="tile"><div class="tile-label">Rooms counted</div>
          <div class="tile-value">{{ b.totals.fullCalendarRooms }}<small>of {{ b.totals.rooms }}</small></div>
          <div class="tile-sub">with their full calendar imported</div></div>
      </section>

      <section class="card">
        <div class="card-head row"><h2>Week of {{ weekLabel() }}</h2>
          <span class="legend"><i class="sw open"></i>open hours <i class="sw cls"></i>scheduled <i class="sw now-sw"></i>now</span></div>
        <div class="b-head" aria-hidden="true">
          <span></span>
          @for (d of dayNames(); track d) { <span>{{ d }}</span> }
          <span class="num">Sched.</span><span class="num">Share</span><span class="num">kWh</span>
        </div>
        <ul class="b-list">
          @for (r of shown(); track r.roomId) {
            <li class="b-row">
              <div class="b-room">
                <a [routerLink]="['/rooms', r.roomId]" class="b-code">{{ r.roomId }}</a>
                <span class="chip small state" [attr.data-state]="r.state">{{ r.state === 'RESERVED' && !r.hasNode ? 'CLASS' : r.state }}</span>
                <div class="b-meta">
                  {{ r.hasNode ? 'Sensor' : 'Timetable only' }} ·
                  @if (r.calendar === 'full') { full calendar } @else { <span class="warn-text">partial</span> }
                </div>
                <div class="b-meta">{{ nowText(r) }}</div>
              </div>
              @for (d of r.days; track d.date; let i = $index) {
                <div class="b-day" role="img" [attr.aria-label]="dayNames()[i] + ': ' + dayText(d.blocks)" [title]="dayNames()[i] + ': ' + dayText(d.blocks)">
                  <span class="b-open" [style.left.%]="pos(b.week.openFrom)" [style.width.%]="pos(b.week.openTo) - pos(b.week.openFrom)"></span>
                  @for (blk of d.blocks; track blk.start) {
                    <span class="b-blk" [style.left.%]="pos(hourOf(blk.start))" [style.width.%]="width(blk.start, blk.end)"></span>
                  }
                  @if (d.date === todayYmd) { <span class="b-now" [style.left.%]="pos(nowHour())"></span> }
                  <span class="b-dayname">{{ dayNames()[i] }}</span>
                </div>
              }
              <span class="num"><span class="lbl">Scheduled </span>{{ r.scheduledH }} h</span>
              <span class="num"><span class="lbl">Share </span>{{ r.sharePct === null ? '—' : r.sharePct + ' %' }}</span>
              <span class="num"><span class="lbl">Avoidable </span>{{ r.estKWhAvoidable === null ? '—' : r.estKWhAvoidable }}<span class="lbl"> kWh</span></span>
            </li>
          } @empty { <li class="empty">No rooms start with “{{ prefix }}”. Import a timetable first.</li> }
        </ul>
        @if (hidden().length) {
          <p class="note">No known classes this week in {{ hidden().join(', ') }}: their calendars are partial, so this says nothing about how empty they are.</p>
        }
        <p class="note">{{ b.assumptions }} “Partial” rooms are known only from a group timetable, so their empty hours are unknown:
          export the room's own calendar from ADE and import it on the Timetable page to count them.</p>
        @if (measured(); as m) {
          <p class="note">Measured by the sensor in {{ m.roomId }} this week: {{ m.occupiedH }} h of presence during {{ m.bookedH }} h booked,
            {{ m.noShows }} no-show{{ m.noShows === 1 ? '' : 's' }}.</p>
        }
      </section>

      @if (trend().length > 1) {
        <section class="card">
          <div class="card-head">
            <h2>Term at a glance</h2>
            <p class="hint">Share of open hours scheduled, week by week, over every week of the imported timetable. Pick a week to see it above.</p>
          </div>
          <ul class="trend" aria-label="Scheduled share per week">
            @for (w of trend(); track w.monday) {
              <li><button type="button" class="t-week" [class.sel]="w.monday === b.week.from" [class.cur]="w.current" [attr.aria-pressed]="w.monday === b.week.from"
                      (click)="goTo(w.monday)" [attr.aria-label]="trendText(w)" [title]="trendText(w)">
                <span class="t-val">{{ w.sharePct === null ? '—' : w.sharePct + '%' }}</span>
                <span class="t-bar"><span [style.height.%]="w.sharePct ?? 0"></span></span>
                <span class="t-lbl">{{ shortDay(w.monday) }}</span>
              </button></li>
            }
          </ul>
          <p class="note">{{ trendNote() }}</p>
        </section>
      }
    }
  `,
  styles: [`
    .week-nav { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
    label.inline { display: flex; align-items: center; gap: 6px; }
    label.inline input { width: 72px; text-transform: uppercase; }
    .legend { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .sw { display: inline-block; width: 14px; height: 8px; border-radius: 2px; margin-left: 6px; }
    .sw.open { background: var(--grid); border: 1px solid var(--line); }
    .sw.cls { background: var(--reserved); }
    .sw.now-sw { width: 2px; height: 12px; background: var(--bad); }
    .b-head, .b-row { display: grid; grid-template-columns: minmax(150px, 1.3fr) repeat(5, minmax(0, 1fr)) 64px 56px 52px; gap: 8px; align-items: center; }
    .b-head { font-size: 12px; font-weight: 600; color: var(--muted); padding: 0 0 6px; border-bottom: 1px solid var(--line); }
    .b-list { list-style: none; margin: 0; padding: 0; }
    .b-row { padding: 10px 0; border-bottom: 1px solid var(--grid); }
    .b-room { min-width: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
    .b-code { font-family: var(--mono); font-weight: 600; text-decoration: none; }
    .b-code:hover { text-decoration: underline; }
    .b-meta { flex-basis: 100%; font-size: 12px; color: var(--muted); }
    .b-day { position: relative; height: 22px; background: var(--bg); border-radius: 4px; overflow: hidden; }
    .b-open { position: absolute; top: 0; bottom: 0; background: var(--grid); }
    .b-blk { position: absolute; top: 4px; bottom: 4px; background: var(--reserved); border-radius: 3px; min-width: 2px; }
    .b-now { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--bad); }
    .b-dayname { display: none; }
    .trend { list-style: none; margin: 0; padding: 0 0 4px; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(40px, 76px); justify-content: start; gap: 6px; overflow-x: auto; }
    .trend li { display: grid; }
    .t-week { display: grid; grid-template-rows: auto 120px auto; gap: 4px; justify-items: center; background: none; border: 1px solid transparent;
      border-radius: 8px; padding: 6px 2px; color: var(--fg); font-weight: 500; }
    .t-week:hover { background: var(--chip); }
    .t-week.sel { border-color: var(--accent); }
    .t-val { font-size: 12px; font-variant-numeric: tabular-nums; }
    .t-bar { position: relative; width: 60%; max-width: 28px; height: 100%; background: var(--grid); border-radius: 4px; overflow: hidden; }
    .t-bar span { position: absolute; left: 0; right: 0; bottom: 0; background: var(--reserved); }
    .t-week.cur .t-bar span { background: var(--accent); }
    .t-lbl { font-size: 11px; color: var(--muted); white-space: nowrap; }
    .num { text-align: right; font-variant-numeric: tabular-nums; font-size: 13.5px; }
    .lbl { display: none; }
    @media (max-width: 760px) {
      .b-head { display: none; }
      .b-row { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .b-room { grid-column: 1 / -1; }
      .b-day { grid-column: 1 / -1; height: 20px; }
      .b-dayname { display: block; position: absolute; left: 4px; top: 2px; font-size: 11px; font-weight: 600; color: var(--muted); }
      .num { text-align: left; }
      .lbl { display: inline; color: var(--muted); font-size: 12px; }
    }
  `]
})
export class BuildingComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private live = inject(LiveService);
  private sub?: Subscription;
  private timer?: ReturnType<typeof setTimeout>;
  readonly hourOf = hourOf;
  readonly data = signal<Building | null>(null);
  readonly error = signal('');
  readonly date = signal(new Date());
  readonly trend = signal<TrendWeek[]>([]);
  private trendPrefix: string | null = null;
  readonly trendNote = computed(() => {
    const w = this.trend().filter((x) => x.sharePct !== null);
    if (!w.length) return 'Shares appear for weeks after a room calendar was imported.';
    const empty = w.reduce((a, x) => a + x.emptyH, 0); const kwh = w.reduce((a, x) => a + x.estKWhAvoidable, 0);
    const lo = w.reduce((a, x) => (x.sharePct! < a.sharePct! ? x : a)); const hi = w.reduce((a, x) => (x.sharePct! > a.sharePct! ? x : a));
    return `Over ${w.length} weeks: ${Math.round(empty)} empty open hours, about ${Math.round(kwh)} kWh of heating avoidable with a schedule-driven setpoint. ` +
      `Busiest week ${this.shortDay(hi.monday)} (${hi.sharePct} %), quietest ${this.shortDay(lo.monday)} (${lo.sharePct} %). Green = this week.`;
  });
  readonly todayYmd = ymd(new Date());
  prefix = 'ME4';

  readonly weekLabel = computed(() => {
    const b = this.data();
    if (!b) return '…';
    const f = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `${f(b.week.from)} – ${f(b.week.to)}`;
  });
  readonly isThisWeek = computed(() => {
    const b = this.data();
    return !!b && this.todayYmd >= b.week.from && this.todayYmd <= b.week.to;
  });
  readonly dayNames = computed(() => {
    const b = this.data();
    if (!b) return [];
    return b.rooms[0]?.days.map((d) => new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }))
      ?? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  });
  // Rooms with a full calendar first; partial rooms only when something is known for them this week.
  readonly shown = computed(() => (this.data()?.rooms ?? [])
    .filter((r) => r.calendar === 'full' || r.sessions > 0)
    .sort((a, b) => Number(b.calendar === 'full') - Number(a.calendar === 'full') || a.roomId.localeCompare(b.roomId)));
  readonly hidden = computed(() => (this.data()?.rooms ?? []).filter((r) => r.calendar !== 'full' && r.sessions === 0).map((r) => r.roomId));
  readonly measured = computed(() => {
    const r = this.data()?.rooms.find((x) => x.measured);
    return r?.measured ? { roomId: r.roomId, ...r.measured } : null;
  });

  ngOnInit() {
    this.load();
    this.sub = this.live.events$.subscribe((e) => {
      if (e.type !== 'room' && e.type !== 'booking') return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.load(), 500);
    });
  }
  ngOnDestroy() { this.sub?.unsubscribe(); clearTimeout(this.timer); }

  async load() {
    try {
      this.prefix = this.prefix.trim().toUpperCase();
      const prefixChanged = this.trendPrefix !== this.prefix;
      const [week, trend] = await Promise.all([this.api.building(this.prefix, ymd(this.date())), prefixChanged ? this.api.buildingTrend(this.prefix) : null]);
      this.data.set(week);
      if (trend) { this.trend.set(trend.weeks); this.trendPrefix = this.prefix; } // the term trend only changes with a new import
      this.error.set('');
    } catch (err) { this.error.set(errorText(err)); }
  }
  shift(days: number) { this.date.set(new Date(this.date().getTime() + days * 864e5)); this.load(); }
  goTo(monday: string) { this.date.set(new Date(`${monday}T12:00:00Z`)); this.load(); }
  shortDay(s: string) { return new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  trendText(w: TrendWeek) {
    return `Week of ${this.shortDay(w.monday)}: ${w.sharePct === null ? 'no full calendar yet' : `${w.sharePct} % scheduled, ${w.emptyH} h empty, ${w.estKWhAvoidable} kWh avoidable`}`;
  }
  today() { this.date.set(new Date()); this.load(); }

  pos(hour: number) { return (Math.min(TO, Math.max(FROM, hour)) - FROM) / (TO - FROM) * 100; }
  width(start: string, end: string) {
    const s = hourOf(start);
    const e = hourOf(end) <= s ? TO : hourOf(end); // a block ending at midnight runs to the edge
    return this.pos(e) - this.pos(s);
  }
  nowHour() { return hourOf(new Date().toISOString()); }
  dayText(blocks: { start: string; end: string; title: string }[]) {
    return blocks.length ? blocks.map((b) => `${fmtTime(b.start)}–${fmtTime(b.end)} ${b.title}`).join('; ') : 'nothing scheduled';
  }
  nowText(r: BuildingRoom) {
    if (r.now) return `Now: ${r.now.title} until ${fmtTime(r.now.until)}${r.now.monitored ? '' : ' (not monitored)'}`;
    if (r.next) {
      const d = new Date(r.next.start);
      return `Next: ${r.next.title}, ${d.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })} ${fmtTime(d)}`;
    }
    return 'Nothing scheduled ahead';
  }
}
