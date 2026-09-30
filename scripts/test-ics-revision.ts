import assert from 'node:assert/strict';
import { buildIcs } from '../lib/ics';

const event = {
  uid: 'visit-123@tradepilot',
  title: 'Site visit — Test Road',
  start: new Date(2026, 8, 7, 9, 30),
  end: new Date(2026, 8, 7, 10, 0),
  sequence: 42,
};

const calendar = buildIcs(event);
assert.match(calendar, /UID:visit-123@tradepilot\r\n/);
assert.match(calendar, /SEQUENCE:42\r\n/);
assert.match(calendar, /LAST-MODIFIED:\d{8}T\d{6}Z\r\n/);
assert.match(calendar, /TRIGGER:-PT1440M\r\n/);
assert.match(calendar, /TRIGGER:-PT60M\r\n/);

console.log('calendar revision and reminder checks passed');
