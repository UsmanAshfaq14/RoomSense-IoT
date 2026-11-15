import { Routes } from '@angular/router';

// Each page is loaded only when visited (RGESN 6.5): the chart library, for example, is only downloaded
// with the room page that uses it.
export const routes: Routes = [
  { path: '', loadComponent: () => import('./overview.component').then((m) => m.OverviewComponent), title: 'RoomSense · Rooms' },
  { path: 'rooms/:id', loadComponent: () => import('./room.component').then((m) => m.RoomComponent), title: 'RoomSense · Room' },
  { path: 'people', loadComponent: () => import('./people.component').then((m) => m.PeopleComponent), title: 'RoomSense · People' },
  { path: 'building', loadComponent: () => import('./building.component').then((m) => m.BuildingComponent), title: 'RoomSense · Floor' },
  { path: 'timetable', loadComponent: () => import('./timetable.component').then((m) => m.TimetableComponent), title: 'RoomSense · Timetable' },
  { path: '**', redirectTo: '' }
];
