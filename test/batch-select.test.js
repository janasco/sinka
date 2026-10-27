import test from 'node:test';
import assert from 'node:assert/strict';

const { selectBatch } = await import('../src/mail.js');

const msg = (uid, size) => ({ uid, messageId: `m${uid}`, size });
const uids = (batch) => batch.map((m) => m.uid);

test('selectBatch: empty or missing input yields []', () => {
  assert.deepEqual(selectBatch([], 5, 100), []);
  assert.deepEqual(selectBatch(null, 5, 100), []);
  assert.deepEqual(selectBatch(undefined, 5, 100), []);
});

test('selectBatch: caps by count', () => {
  const fresh = [msg(1, 10), msg(2, 10), msg(3, 10), msg(4, 10)];
  assert.deepEqual(uids(selectBatch(fresh, 2, 1000)), [1, 2]);
});

test('selectBatch: oldest always goes, even over the byte budget', () => {
  const fresh = [msg(1, 5000), msg(2, 10)];
  assert.deepEqual(uids(selectBatch(fresh, 5, 100)), [1]);
});

test('selectBatch: small mail drains around an over-budget middle message', () => {
  const fresh = [msg(1, 10), msg(2, 5000), msg(3, 10), msg(4, 10)];
  assert.deepEqual(uids(selectBatch(fresh, 5, 100)), [1, 3, 4]);
});

test('selectBatch: count limit still applies while skipping', () => {
  const fresh = [msg(1, 10), msg(2, 5000), msg(3, 10), msg(4, 10), msg(5, 10)];
  assert.deepEqual(uids(selectBatch(fresh, 2, 100)), [1, 3]);
});

test('selectBatch: missing sizes count as zero, order preserved', () => {
  const fresh = [{ uid: 1 }, { uid: 2, size: 5 }, { uid: 3 }];
  assert.deepEqual(uids(selectBatch(fresh, 5, 5)), [1, 2, 3]);
});

test('selectBatch: invalid limits fall back to a single message', () => {
  const fresh = [msg(1, 10), msg(2, 10)];
  assert.deepEqual(uids(selectBatch(fresh, 0, 0)), [1]);
  assert.deepEqual(uids(selectBatch(fresh, 'bogus', 'bogus')), [1]);
});
