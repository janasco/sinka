import test from 'node:test';
import assert from 'node:assert/strict';

const { getAutoDisabled, getPending } = await import('../src/mail.js');

test('getAutoDisabled() is initially empty', () => {
  assert.deepEqual(getAutoDisabled(), []);
});

test('getPending() is initially empty', () => {
  assert.deepEqual(getPending(), []);
});
