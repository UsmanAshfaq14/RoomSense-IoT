import { RoomEvent } from './api.service';

// One readable sentence per event in the activity log.
export function describeEvent(e: RoomEvent): string {
  const who = e.userName ? ` ${e.userName}` : '';
  const d = e.details || {};
  switch (e.type) {
    case 'access_granted': return `Badge${who}: ${d.reason || 'granted'}`;
    case 'access_denied': return `Badge${who || ' (unknown)'} refused${d.reason ? `: ${d.reason}` : ''}`;
    case 'check_in': return d.how === 'presence' ? 'Class started: motion detected' : `Checked in${who}`;
    case 'walk_in': return `Walk-in booking${who}`;
    case 'no_show': return `No-show${d.title ? ` (${d.title})` : ''}: booking cancelled, heating back to eco`;
    case 'released': return `Room released: ${d.reason || 'no motion'}`;
    case 'completed': return `Booking ended${d.reason ? `: ${d.reason}` : ''}`;
    case 'not_monitored': return `Booking ended unjudged${d.title ? ` (${d.title})` : ''}: the room was not watched from its start`;
    case 'light_on': return 'Lights on (automatic)';
    case 'light_off': return 'Lights off (automatic)';
    case 'heating_on': return 'Heating on (automatic)';
    case 'heating_off': return 'Heating off (automatic)';
    case 'fan_on': return 'Ventilation fan on (automatic)';
    case 'fan_off': return 'Ventilation fan off (automatic)';
    case 'air_alert': return `Air quality alert${d.humidity ? `: humidity ${d.humidity} %` : ''}`;
    case 'override': return d.mode === 'auto' ? `${d.actuator} back to automatic` : `Manual ${d.actuator}: ${JSON.stringify(d.command)}`;
    case 'node_online': return 'Room node online';
    case 'node_offline': return 'Room node offline';
    case 'bad_message': return `Rejected a malformed message${d.error ? ` (${d.error})` : ''}`;
    case 'timetable_import': return `Timetable imported: ${d.added ?? 0} new sessions`;
    default: return e.type;
  }
}
