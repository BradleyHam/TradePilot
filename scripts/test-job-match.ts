import assert from 'node:assert/strict';
import { safeAutoJobMatch } from '../lib/job-match';
import type { Job } from '../lib/types';

const now = new Date('2026-09-04T10:00:00+12:00');

function job(id: string, name: string, location: string): Job {
  return {
    id,
    businessId: 'business',
    name,
    clientName: 'Client',
    location,
    status: 'lead',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

const jobs = [
  job('anderson', 'Internal painting — 20 Anderson Road', '20 Anderson Road, Wanaka'),
  job('tank', 'Tank Wanaka — GIB stopping + painting', 'Wanaka'),
  job('tasman', 'Tasman Holiday Park in Wanaka', 'Wanaka'),
];

assert.equal(safeAutoJobMatch(jobs, 'WANAKA', 10, now), undefined);
assert.equal(safeAutoJobMatch(jobs, 'WANAKA - WAN9834', 10, now), undefined);
assert.equal(safeAutoJobMatch(jobs, '20 Anderson Road, Wanaka', 10, now)?.id, 'anderson');
assert.equal(safeAutoJobMatch(jobs, 'Tank Wanaka', 10, now)?.id, 'tank');
assert.equal(safeAutoJobMatch(jobs, 'Tasman Holiday Park', 10, now)?.id, 'tasman');

const tiedJobs = [
  job('smith-a', 'Smith interior', '1 Alpha Road'),
  job('smith-b', 'Smith exterior', '2 Beta Road'),
];
assert.equal(safeAutoJobMatch(tiedJobs, 'Smith', 10, now), undefined);

console.log('job auto-match safety checks passed');
