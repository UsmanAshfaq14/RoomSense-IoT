import { Component, computed, input } from '@angular/core';
import { DayTimeline } from './api.service';

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
const H = 3600e3;

// One room's day as stacked lanes on a shared time axis: plain positioned divs, no chart library needed.
// The axis shows the open hours (07:00-20:00) and stretches when something happened outside them.
@Component({
  selector: 'app-day-timeline',
  template: `
    @if (view(); as v) {
      <div class="tl" role="img" [attr.aria-label]="v.summary">
        <div class="tl-axis">
          @for (t of v.ticks; track t.x) { <span [style.left.%]="t.x">{{ t.label }}</span> }
        </div>
        @for (lane of v.lanes; track lane.key) {
          <div class="tl-row">
            <span class="tl-name">{{ lane.label }}</span>
            <div class="tl-track">
              @for (t of v.ticks; track t.x) { <i class="tl-grid" [style.left.%]="t.x"></i> }
              @for (b of lane.blocks; track b.left) {
                <div class="tl-block" [attr.data-lane]="lane.key" [attr.data-status]="b.status"
                     [style.left.%]="b.left" [style.width.%]="b.width" [title]="b.tip"></div>
              }
              @if (v.nowX !== null) { <i class="tl-now" [style.left.%]="v.nowX"></i> }
            </div>
            <span class="tl-total">{{ lane.total }}</span>
          </div>
        }
      </div>
      <p class="note">{{ v.summary }}</p>
    }
  `,
  styles: [`
    .tl { display: grid; gap: 6px; font-size: 12px; }
    .tl-axis { position: relative; height: 16px; margin: 0 52px 0 86px; color: var(--muted); }
    .tl-axis span { position: absolute; transform: translateX(-50%); font-variant-numeric: tabular-nums; }
    .tl-row { display: grid; grid-template-columns: 80px 1fr 46px; gap: 6px; align-items: center; }
    .tl-name { color: var(--muted); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tl-total { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
    .tl-track { position: relative; height: 18px; background: var(--chip); border-radius: 4px; overflow: hidden; }
    .tl-grid { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line); }
    .tl-now { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--fg); }
    .tl-block { position: absolute; top: 2px; bottom: 2px; min-width: 2px; border-radius: 3px; background: var(--muted); }
    .tl-block[data-lane="scheduled"] { background: var(--reserved); }
    .tl-block[data-lane="booked"] { background: #748ffc; }
    .tl-block[data-lane="booked"][data-status="no_show"], .tl-block[data-lane="scheduled"][data-status="no_show"] {
      background: repeating-linear-gradient(135deg, var(--bad) 0 4px, transparent 4px 8px); }
    .tl-block[data-status="unmonitored"] { opacity: 0.45; }
    .tl-block[data-lane="occupied"] { background: var(--ok); }
    .tl-block[data-lane="heating"] { background: #d9480f; }
    .tl-block[data-lane="lights"] { background: #e8a400; }
    .tl-block[data-lane="fan"] { background: #1c7ed6; }
    .tl-block[data-lane="offline"] { background: repeating-linear-gradient(135deg, var(--muted) 0 3px, transparent 3px 7px); }
    @media (max-width: 560px) { .tl-row { grid-template-columns: 58px 1fr 40px; } .tl-axis { margin: 0 46px 0 64px; } }
  `]
})
export class DayTimelineComponent {
  readonly data = input<DayTimeline | null>(null);

  readonly view = computed(() => {
    const d = this.data();
    if (!d) return null;
    const day0 = Date.parse(d.from); const day1 = Date.parse(d.to); const now = Date.parse(d.now);
    const L = d.lanes;
    const all = [...L.scheduled, ...L.booked, ...L.occupied, ...L.heating, ...L.lights, ...L.fan];
    // default window 07:00-20:00, widened to whole hours around anything outside it
    let from = day0 + 7 * H; let to = day0 + 20 * H;
    for (const b of all) { from = Math.min(from, Date.parse(b.start)); to = Math.max(to, Date.parse(b.end)); }
    from = Math.max(day0, Math.floor((from - day0) / H) * H + day0);
    to = Math.min(day1, Math.ceil((to - day0) / H) * H + day0);
    const span = to - from;
    const x = (ms: number) => Math.min(100, Math.max(0, (ms - from) / span * 100));
    const step = span > 16 * H ? 3 * H : 2 * H;
    const ticks = [];
    for (let t = Math.ceil((from - day0) / step) * step + day0; t <= to; t += step) ticks.push({ x: x(t), label: hhmm(t).slice(0, 2) + 'h' });

    const dur = (list: { start: string; end: string }[]) => list.reduce((s, b) => s + Date.parse(b.end) - Date.parse(b.start), 0);
    const fmtDur = (ms: number) => (ms ? (ms >= H ? `${(ms / H).toFixed(1)} h` : `${Math.round(ms / 60e3)} min`) : '–');
    type B = { start: string; end: string; title?: string | null; status?: string; userName?: string | null; source?: string };
    const lane = (key: string, label: string, list: B[], what: string) => ({
      key, label, total: fmtDur(dur(list)),
      blocks: list.map((b) => {
        const s = Date.parse(b.start); const e = Date.parse(b.end);
        const who = b.source === 'walk_in' ? `walk-in ${b.userName || ''}` : b.title || b.userName || '';
        const status = b.status ? ` · ${b.status.replace('_', '-')}` : '';
        return { left: x(s), width: Math.max(0.3, x(e) - x(s)), status: b.status || '', tip: `${what}${who ? ` ${who}` : ''}: ${hhmm(s)}–${hhmm(e)}${status}` };
      })
    });
    const lanes = d.hasNode
      ? [
          lane('scheduled', 'Timetable', L.scheduled, 'Class'),
          lane('booked', 'Bookings', L.booked, 'Booking'),
          lane('occupied', 'Occupied', L.occupied, 'Someone there'),
          lane('heating', 'Heating', L.heating, 'Heating on'),
          lane('lights', 'Lights', L.lights, 'Lights on'),
          lane('fan', 'Fan', L.fan, 'Fan running'),
          ...(L.offline.length ? [lane('offline', 'Node off', L.offline, 'Room node offline')] : [])
        ]
      : [lane('scheduled', 'Timetable', L.scheduled, 'Class')];

    const booked = dur(L.scheduled) + dur(L.booked);
    const summary = d.hasNode
      ? `Scheduled or booked ${fmtDur(booked)}, someone there ${fmtDur(dur(L.occupied))}, heating on ${fmtDur(dur(L.heating))}, lights on ${fmtDur(dur(L.lights))}. ` +
        `"Occupied" holds ${d.presenceHoldMin} min after the last motion, the same rule that keeps the lights on. Hover a block for its times.`
      : 'This room has no node: only its timetable is known.';
    return { ticks, lanes, summary, nowX: now > from && now < to && now < day1 ? x(now) : null };
  });
}
