import assert from 'node:assert/strict';
import { hourSlices } from '../lib/hours-breakdown';

assert.deepEqual(hourSlices(['painting', 'stopping'], { painting: '2.5', stopping: '2.5' }), [
  { activity: 'painting', hours: 2.5 }, { activity: 'stopping', hours: 2.5 },
]);
assert.deepEqual(hourSlices(['painting', 'stopping'], { painting: '5', stopping: '' }), [
  { activity: 'painting', hours: 5 },
]);
assert.deepEqual(hourSlices(['painting', 'stopping'], { painting: '3.25', stopping: '0' }), [
  { activity: 'painting', hours: 3.25 },
]);
assert.deepEqual(hourSlices([], { '': ' 5 ' }), [{ activity: undefined, hours: 5 }]);
for (const value of ['', '0', '-1', 'NaN', 'Infinity', '2oops']) {
  assert.throws(() => hourSlices(['painting'], { painting: value }));
}
assert.throws(() => hourSlices(['painting', 'stopping'], { painting: '5', stopping: '-1' }));
// Deselected activities must not leak back into the saved day.
assert.deepEqual(hourSlices(['painting'], { painting: '5', stopping: '3' }), [{ activity: 'painting', hours: 5 }]);
console.log('Hours breakdown tests passed');
