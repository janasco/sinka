import test from 'node:test';
import assert from 'node:assert/strict';

const { parseSinks } = await import('../src/mail.js');

test('empty input yields no sinks', () => {
  assert.deepEqual(parseSinks(''), []);
  assert.deepEqual(parseSinks(null), []);
  assert.deepEqual(parseSinks(undefined), []);
  assert.deepEqual(parseSinks('   '), []);
});

test('single active entry', () => {
  assert.deepEqual(parseSinks('user1@gmail.com:pass1'), [
    { user: 'user1@gmail.com', pass: 'pass1', enabled: true },
  ]);
});

test('multiple active entries', () => {
  assert.deepEqual(parseSinks('user1@gmail.com:pass1;user2@gmail.com:pass2'), [
    { user: 'user1@gmail.com', pass: 'pass1', enabled: true },
    { user: 'user2@gmail.com', pass: 'pass2', enabled: true },
  ]);
});

test('disabled (-) entries stay configured with enabled:false', () => {
  assert.deepEqual(parseSinks('-team3@example.com:pass3'), [
    { user: 'team3@example.com', pass: 'pass3', enabled: false },
  ]);
});

test('mixed active and disabled entries', () => {
  assert.deepEqual(parseSinks('a@x.com:pa;-b@x.com:pb;c@x.com:pc'), [
    { user: 'a@x.com', pass: 'pa', enabled: true },
    { user: 'b@x.com', pass: 'pb', enabled: false },
    { user: 'c@x.com', pass: 'pc', enabled: true },
  ]);
});

test('entries with empty password are dropped', () => {
  assert.deepEqual(parseSinks('user@gmail.com:'), []);
  assert.deepEqual(parseSinks('user@gmail.com:;other@x.com:ok'), [
    { user: 'other@x.com', pass: 'ok', enabled: true },
  ]);
});

test('entries without a colon are dropped', () => {
  assert.deepEqual(parseSinks('not-an-entry'), []);
  assert.deepEqual(parseSinks('a@x.com:ok;garbage; b@x.com:ok2'), [
    { user: 'a@x.com', pass: 'ok', enabled: true },
    { user: 'b@x.com', pass: 'ok2', enabled: true },
  ]);
});

test('spaces in passwords are stripped', () => {
  assert.deepEqual(parseSinks('a@x.com:ab cd ef'), [
    { user: 'a@x.com', pass: 'abcdef', enabled: true },
  ]);
  // Gmail App Passwords are often shown as "abcd efgh ijkl mnop".
  assert.deepEqual(parseSinks('a@x.com:abcd efgh ijkl mnop'), [
    { user: 'a@x.com', pass: 'abcdefghijklmnop', enabled: true },
  ]);
});

test('surrounding whitespace and empty segments are ignored', () => {
  assert.deepEqual(parseSinks('  a@x.com:pa  ; ; b@x.com:pb  '), [
    { user: 'a@x.com', pass: 'pa', enabled: true },
    { user: 'b@x.com', pass: 'pb', enabled: true },
  ]);
});

test('password keeps everything after the first colon', () => {
  assert.deepEqual(parseSinks('a@x.com:p:a:ss'), [
    { user: 'a@x.com', pass: 'p:a:ss', enabled: true },
  ]);
});

test('disabled entry with spaces after dash', () => {
  assert.deepEqual(parseSinks('- team4@example.com:pass4'), [
    { user: 'team4@example.com', pass: 'pass4', enabled: false },
  ]);
});
