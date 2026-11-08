import { signal } from '@preact/signals';

export const TIME_ZONE_STORAGE_KEY = 'atmusic.timeZone';

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value === 'auto') return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function readPreference(): string {
  try {
    const stored = localStorage.getItem(TIME_ZONE_STORAGE_KEY);
    return isTimeZone(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

export const timeZonePreference = signal(readPreference());

export function refreshTimeZonePreference(): void {
  timeZonePreference.value = readPreference();
}

export function setTimeZonePreference(value: string): void {
  const preference = value === 'auto' || isTimeZone(value) ? value : 'auto';
  timeZonePreference.value = preference;
  try {
    if (preference === 'auto') localStorage.removeItem(TIME_ZONE_STORAGE_KEY);
    else localStorage.setItem(TIME_ZONE_STORAGE_KEY, preference);
  } catch {
    // The in-memory preference remains usable when browser storage is blocked.
  }
}

export function activeTimeZone(): string | undefined {
  const preference = timeZonePreference.value;
  return isTimeZone(preference) ? preference : undefined;
}

export function detectedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function supportedTimeZones(): string[] {
  let zones: string[];
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
    zones = intl.supportedValuesOf?.('timeZone') ?? ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
  } catch {
    zones = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
  }
  return [...new Set(['UTC', ...zones])].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}
