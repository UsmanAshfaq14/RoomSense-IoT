import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService, Booking, Room, errorText, fmtDay, fmtTime } from './api.service';
import { LiveService } from './live.service';

@Component({
  selector: 'app-overview',
  imports: [RouterLink],
  template: `
    <section class="page-head">
      <h1>Rooms</h1>
      <p class="sub">State of every room RoomSense knows: from its own sensors, or from the timetable.</p>
    </section>
    @if (error()) { <p class="banner error" role="alert">{{ error() }}</p> }
    <div class="room-grid">
      @for (r of rooms(); track r._id) {
        <a class="room-card" [routerLink]="['/rooms', r._id]">
          <div class="room-card-top">
            <span class="code">{{ r._id }}</span>
            <span class="chip state" [attr.data-state]="r.state">{{ r.state }}</span>
          </div>
          <div class="room-card-name">{{ r.name }}</div>
          <div class="room-card-sub">
            @if (r.hasNode === false) { Timetable only } @else { Node {{ r.nodeStatus }} }
            @if (r.airAlert) { · <b class="warn-text">ventilate</b> }
          </div>
          <div class="room-card-next">{{ nextFor(r._id) }}</div>
        </a>
      } @empty {
        @if (!error()) { <p class="empty">Loading rooms…</p> }
      }
    </div>
  `
})
export class OverviewComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private live = inject(LiveService);
  private sub?: Subscription;
  private timer?: ReturnType<typeof setTimeout>;
  readonly rooms = signal<Room[]>([]);
  readonly bookings = signal<Booking[]>([]);
  readonly error = signal('');

  ngOnInit() {
    this.load();
    this.sub = this.live.events$.subscribe((e) => {
      if (e.type === 'reading') return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.load(), 300);
    });
  }
  ngOnDestroy() { this.sub?.unsubscribe(); clearTimeout(this.timer); }

  private async load() {
    try {
      const [rooms, bookings] = await Promise.all([this.api.rooms(), this.api.bookings(undefined, new Date(), new Date(Date.now() + 30 * 24 * 3600e3))]);
      this.rooms.set(rooms.sort((a, b) => Number(b.hasNode !== false) - Number(a.hasNode !== false) || a._id.localeCompare(b._id)));
      this.bookings.set(bookings);
      this.error.set('');
    } catch (err) { this.error.set(errorText(err)); }
  }

  nextFor(roomId: string) {
    const b = this.bookings().find((x) => x.roomId === roomId && (x.status === 'pending' || x.status === 'checked_in'));
    if (!b) return 'Nothing booked';
    const who = b.source === 'timetable' ? (b.title ? `class ${b.title}` : 'class') : (b.userName || 'booking');
    return `${b.status === 'checked_in' ? 'Now' : 'Next'}: ${who}, ${fmtDay(b.start)} ${fmtTime(b.start)}`;
  }
}
