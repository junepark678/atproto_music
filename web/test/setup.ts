// Deterministic local time: every web test runs in UTC unless it calls
// setTimeZone itself (Node re-reads TZ for Date and Intl on assignment).
import { afterEach } from 'vitest';

export function setTimeZone(zone: string): void {
  (globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = zone;
}

setTimeZone('UTC');
afterEach(() => setTimeZone('UTC'));
