import { Component, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LiveService } from './live.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="skip" href="#main" (click)="skip($event)">Skip to content</a>
    <header class="topbar">
      <div class="wrap topbar-inner">
        <a routerLink="/" class="brand">Room<span>Sense</span></a>
        <nav aria-label="Main">
          <a routerLink="/rooms/ME407" routerLinkActive="active">ME407</a>
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">All rooms</a>
          <a routerLink="/building" routerLinkActive="active">ME4 floor</a>
          <a routerLink="/people" routerLinkActive="active">People</a>
          <a routerLink="/timetable" routerLinkActive="active">Timetable</a>
        </nav>
        @if (demo()) { <span class="live demo" title="Demo mode: every room-logic minute lasts one second (10 min no-show grace = 10 s), on the separate demo database">Demo · 1 min = 1 s</span> }
        <span class="live" [class.on]="live.connected()" [attr.title]="live.connected() ? 'Live updates connected' : 'Reconnecting to the server…'">
          {{ live.connected() ? 'Live' : 'Offline' }}
        </span>
      </div>
    </header>
    <main class="wrap" id="main" tabindex="-1"><router-outlet /></main>
  `
})
export class AppComponent {
  readonly live = inject(LiveService);
  readonly demo = signal(false);
  // move focus (not only the scroll position) to the content, so the next Tab starts there
  skip(e: Event) { e.preventDefault(); const m = document.getElementById('main'); m?.focus(); m?.scrollIntoView(); }
  constructor() { inject(ApiService).health().then((h) => this.demo.set(h.demo)).catch(() => {}); }
}
