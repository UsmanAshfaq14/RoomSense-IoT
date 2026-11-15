import { Injectable, NgZone, OnDestroy, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { API } from './api.service';

export interface LiveEvent { type: string; data: any }

// Server-sent events from /api/stream: the server pushes each change, the page never polls.
@Injectable({ providedIn: 'root' })
export class LiveService implements OnDestroy {
  private zone = inject(NgZone);
  private source?: EventSource;
  readonly connected = signal(false);
  readonly events$ = new Subject<LiveEvent>();

  constructor() { this.open(); }

  private open() {
    const types = ['reading', 'node', 'access', 'actuator', 'room', 'booking', 'air'];
    this.source = new EventSource(`${API}/stream`);
    this.source.addEventListener('hello', () => this.zone.run(() => this.connected.set(true)));
    this.source.onerror = () => this.zone.run(() => this.connected.set(false)); // EventSource reconnects by itself
    for (const type of types) {
      this.source.addEventListener(type, (e) => {
        const data = JSON.parse((e as MessageEvent).data);
        this.zone.run(() => this.events$.next({ type, data }));
      });
    }
  }

  ngOnDestroy() { this.source?.close(); }
}
