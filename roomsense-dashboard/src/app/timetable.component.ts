import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Booking, errorText, fmtDay, fmtTime } from './api.service';

@Component({
  selector: 'app-timetable',
  imports: [FormsModule],
  template: `
    <section class="page-head">
      <h1>Timetable</h1>
      <p class="sub">Import the university timetable so classes count as bookings. Only room, time and course code are kept.</p>
    </section>
    <div class="two-col">
      <section class="card">
        <div class="card-head"><h2>Import</h2>
          <p class="hint">Choose an .ics file, or paste the text of the forwarded invitations (Time / Location / Description).</p></div>
        <form class="stack" (ngSubmit)="import()">
          <label>Calendar file <input type="file" accept=".ics,.txt,text/calendar,text/plain" (change)="pick($event)"></label>
          <label>…or paste the text <textarea name="text" rows="10" [(ngModel)]="text" [attr.aria-invalid]="isError() || null" [attr.aria-describedby]="isError() ? 'import-result' : null" placeholder="Time&#10;Wednesday, December 16, 2026 09:30 to 12:30&#10;Location&#10;ME407.1&#10;Description&#10;&#10;ILMCA2TD02"></textarea></label>
          <label>Only rooms starting with <input name="rooms" [(ngModel)]="rooms" placeholder="ME4 (leave empty for every room)"></label>
          <button type="submit" class="primary" [disabled]="!text.trim()">Import</button>
        </form>
        @if (result()) { <p class="banner" id="import-result" [class.error]="isError()" [attr.role]="isError() ? 'alert' : 'status'">{{ result() }}</p> }
      </section>
      <section class="card">
        <div class="card-head"><h2>Imported classes, next 60 days</h2></div>
        <ul class="list">
          @for (b of sessions(); track b._id) {
            <li><span class="when">{{ fmtDay(b.start) }} · {{ fmtTime(b.start) }}–{{ fmtTime(b.end) }}</span>
              <span class="code">{{ b.roomId }}</span><span class="what">{{ b.title || 'class' }}</span>
              <span class="chip small" [attr.data-status]="b.status">{{ b.status === 'unmonitored' ? 'not monitored' : b.status.replace('_', '-') }}</span></li>
          } @empty { <li class="empty">No classes imported yet.</li> }
        </ul>
      </section>
    </div>
  `
})
export class TimetableComponent implements OnInit {
  private api = inject(ApiService);
  readonly fmtDay = fmtDay; readonly fmtTime = fmtTime;
  readonly all = signal<Booking[]>([]);
  readonly sessions = computed(() => this.all().filter((b) => b.source === 'timetable'));
  readonly result = signal('');
  readonly isError = signal(false);
  text = '';
  rooms = 'ME4';

  ngOnInit() { this.load(); }
  private async load() {
    try { this.all.set(await this.api.bookings(undefined, new Date(), new Date(Date.now() + 60 * 24 * 3600e3))); } catch { /* shown on import */ }
  }
  async pick(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.text = await file.text();
  }
  async import() {
    try {
      const r = await this.api.importTimetable(this.text, this.rooms);
      const rooms = Object.entries(r.rooms).map(([k, v]) => `${k} (${v})`).join(', ') || 'none';
      const outside = r.outsideFilter ? ` ${r.outsideFilter} in other rooms ignored.` : '';
      this.result.set(`${r.sessionsFound} classes found:${outside} ${r.added} added, ${r.alreadyImported} already known, ${r.notMonitored} already started (kept, not monitored). Rooms: ${rooms}.${r.fullCalendar.length ? ` Full room calendar: ${r.fullCalendar.join(', ')}.` : ''}`);
      this.isError.set(false);
      this.load();
    } catch (err) { this.result.set(errorText(err)); this.isError.set(true); }
  }
}
