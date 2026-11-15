import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

// The RoomSense server (Express). Served by the server itself (npm run build, then npm start in the server):
// same origin, so a relative path. During development with ng serve (port 4200) the API is on port 3000.
export const API = location.port === '4200' ? 'http://localhost:3000/api' : '/api';

export type RoomState = 'FREE' | 'RESERVED' | 'OCCUPIED' | 'OFFLINE';
export interface Reading { value: number; ts: string }
export interface Booking {
  _id: string; roomId: string; userId: string | null; userName: string | null; start: string; end: string;
  status: 'pending' | 'checked_in' | 'no_show' | 'released' | 'completed' | 'cancelled' | 'unmonitored';
  source: 'user' | 'walk_in' | 'timetable'; title: string | null; location?: string; endReason?: string; checkInAt?: string;
}
export interface Room {
  _id: string; name: string; building?: string; state: RoomState; nodeStatus: 'online' | 'offline'; hasNode?: boolean; gasReady?: boolean;
  comfortC: number; ecoC: number; luxThreshold: number; lastSeen?: string; airAlert?: boolean;
  preheatMin?: number; graceMin?: number; presenceTimeoutMin?: number; releaseTimeoutMin?: number;
  humidityMax?: number; gasMinOhms?: number; lightPowerW?: number; heatingPowerW?: number;
  actuators: Record<string, { on?: boolean; level?: number; speed?: number; state?: string; ts: string }>;
}
export interface RoomDetail extends Room {
  latest: Partial<Record<'presence' | 'temperature' | 'humidity' | 'pressure' | 'gas' | 'light', Reading>>;
  overrides: Record<string, { until: string; command: unknown }>;
  settingsDefaults: Record<string, number>;
  currentBooking: Booking | null; nextBooking: Booking | null;
  clock?: RoomClock;
}
type Span = { start: string; end: string };
export interface DayTimeline {
  roomId: string; date: string; hasNode: boolean; presenceHoldMin: number; from: string; to: string; now: string;
  lanes: {
    scheduled: (Span & { title: string | null; status: string; source: string; userName: string | null })[];
    booked: (Span & { title: string | null; status: string; source: string; userName: string | null })[];
    occupied: Span[]; heating: Span[]; lights: Span[]; fan: Span[]; offline: Span[];
  };
}
// Deadlines the room logic is working towards (absolute times; in demo mode a "minute" lasts a second)
export interface RoomClock {
  serverNow: string; unitMs: number; watching: boolean;
  mode: 'timetable' | 'free' | 'booked' | 'waiting' | 'in_use';
  startsAt?: string; endsAt?: string; preheatAt?: string; noShowAt?: string | null;
  releaseAt?: string | null; motionNow?: boolean; attendees?: number;
}
export interface User { _id: string; name: string; email?: string; role: 'student' | 'admin'; createdAt?: string }
export interface RoomEvent { _id: string; ts: string; roomId: string; type: string; source: string; userName: string | null; details: any }
export interface DayStats {
  date: string; bookedMin?: number; occupiedMin?: number; noShows?: number; lightsOnMin?: number;
  heatingOnMin?: number; fanOnMin?: number; estLightWhAvoided?: number; estHeatWhAvoided?: number;
}
export interface Point { ts: string; value: number }
export interface BuildingRoom {
  roomId: string; name: string; hasNode: boolean; state: RoomState; nodeStatus: 'online' | 'offline';
  now: { title: string; until: string; monitored: boolean } | null; next: { title: string; start: string } | null;
  sessions: number; scheduledH: number; inOpenH: number; outsideOpenH: number; openH: number; calendar: 'full' | 'partial';
  sharePct: number | null; emptyH: number | null; estKWhAvoidable: number | null;
  days: { date: string; blocks: { start: string; end: string; title: string }[] }[];
  measured?: { bookedH: number; occupiedH: number; noShows: number };
}
export interface TrendWeek { monday: string; current: boolean; sharePct: number | null; emptyH: number; estKWhAvoidable: number; sessions: number; fullCalendarRooms: number }
export interface Building {
  prefix: string; week: { from: string; to: string; openFrom: number; openTo: number }; assumptions: string;
  totals: { rooms: number; fullCalendarRooms: number; sessions: number; scheduledH: number; openH: number; sharePct: number | null; emptyH: number; estKWhAvoidable: number };
  rooms: BuildingRoom[];
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  private get<T>(path: string) { return firstValueFrom(this.http.get<T>(`${API}${path}`)); }
  private send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, contentType = 'application/json') {
    const headers = new HttpHeaders({ 'Content-Type': contentType });
    return firstValueFrom(this.http.request<T>(method, `${API}${path}`, { body, headers }));
  }

  health() { return this.get<{ ok: boolean; database: string; mqttClients: number; demo: boolean }>('/health'); }
  rooms() { return this.get<Room[]>('/rooms'); }
  room(id: string) { return this.get<RoomDetail>(`/rooms/${id}`); }
  readings(id: string, type: string, hours: number) { return this.get<Point[]>(`/rooms/${id}/readings?type=${type}&hours=${hours}`); }
  timeline(id: string, date: string) { return this.get<DayTimeline>(`/rooms/${id}/timeline?date=${date}`); }
  stats(id: string, days = 7) { return this.get<{ note: string; days: DayStats[] }>(`/rooms/${id}/stats?days=${days}`); }
  events(roomId?: string, limit = 40) { return this.get<RoomEvent[]>(`/events?limit=${limit}${roomId ? `&roomId=${roomId}` : ''}`); }
  bookings(roomId?: string, from?: Date, to?: Date) {
    const q = new URLSearchParams();
    if (roomId) q.set('roomId', roomId);
    if (from) q.set('from', from.toISOString());
    if (to) q.set('to', to.toISOString());
    return this.get<Booking[]>(`/bookings?${q}`);
  }
  users() { return this.get<User[]>('/users'); }
  buildingTrend(prefix: string) { return this.get<{ prefix: string; weeks: TrendWeek[] }>(`/building/trend?prefix=${encodeURIComponent(prefix)}`); }
  building(prefix: string, date: string) { return this.get<Building>(`/building?prefix=${encodeURIComponent(prefix)}&date=${date}`); }
  lastUnknownBadge() { return this.get<{ uid: string; roomId: string; at: string } | null>('/rfid/last-unknown'); }

  actuator(roomId: string, name: string, body: Record<string, unknown>) { return this.send(`POST`, `/rooms/${roomId}/actuators/${name}`, body); }
  settings(roomId: string, body: Record<string, unknown>) { return this.send<Room>('PUT', `/rooms/${roomId}/settings`, body); }
  book(body: { roomId: string; userId: string; start: string; end: string; title?: string }) { return this.send<Booking>('POST', '/bookings', body); }
  cancel(id: string) { return this.send('DELETE', `/bookings/${id}`); }
  register(body: { name: string; email?: string; role: string; rfidUid: string }) { return this.send<User>('POST', '/users', body); }
  importTimetable(text: string, rooms = '') {
    const q = rooms.trim() ? `?rooms=${encodeURIComponent(rooms.trim())}` : '';
    return this.send<{ sessionsFound: number; outsideFilter: number; added: number; alreadyImported: number; notMonitored: number; fullCalendar: string[]; rooms: Record<string, number> }>(
      'POST', `/timetable/import${q}`, text, 'text/plain');
  }
}

// Turns any HTTP failure into one sentence for the page.
export function errorText(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'The server is not reachable. Is "npm start" running in roomsense-server?';
    return (err.error && err.error.error) || `${err.status} ${err.statusText}`;
  }
  return String(err);
}

const TZ = 'Europe/Paris';
export const fmtTime = (d: string | Date) => new Date(d).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
export const fmtDay = (d: string | Date) => new Date(d).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
// Time only for today; weekday and time for older entries.
export const fmtWhen = (d: string | Date) => {
  const day = (x: Date) => x.toLocaleDateString('en-GB', { timeZone: TZ });
  return day(new Date(d)) === day(new Date()) ? fmtTime(d) : `${new Date(d).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short' })} ${fmtTime(d)}`;
};
export const fmtAgo = (d: string | Date) => {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${fmtDay(d)} ${fmtTime(d)}`;
};
