import test from 'node:test';
import assert from 'node:assert/strict';

const { mapLimit, getAppendConcurrency } = await import('../src/mail.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function saveEnv() {
  return Object.prototype.hasOwnProperty.call(process.env, 'APPEND_CONCURRENCY')
    ? process.env.APPEND_CONCURRENCY
    : undefined;
}

function restoreEnv(saved) {
  if (saved === undefined) delete process.env.APPEND_CONCURRENCY;
  else process.env.APPEND_CONCURRENCY = saved;
}

test('getAppendConcurrency: unset/empty/invalid/<=0 means unlimited (0)', async (t) => {
  const saved = saveEnv();
  t.after(() => restoreEnv(saved));
  delete process.env.APPEND_CONCURRENCY;
  assert.equal(getAppendConcurrency(), 0);
  process.env.APPEND_CONCURRENCY = '';
  assert.equal(getAppendConcurrency(), 0);
  process.env.APPEND_CONCURRENCY = '0';
  assert.equal(getAppendConcurrency(), 0);
  process.env.APPEND_CONCURRENCY = '-2';
  assert.equal(getAppendConcurrency(), 0);
  process.env.APPEND_CONCURRENCY = 'abc';
  assert.equal(getAppendConcurrency(), 0);
  process.env.APPEND_CONCURRENCY = '2.9';
  assert.equal(getAppendConcurrency(), 2);
});

test('getAppendConcurrency: N>=1 parses as int', async (t) => {
  const saved = saveEnv();
  t.after(() => restoreEnv(saved));
  process.env.APPEND_CONCURRENCY = '3';
  assert.equal(getAppendConcurrency(), 3);
  process.env.APPEND_CONCURRENCY = ' 2 ';
  assert.equal(getAppendConcurrency(), 2);
  process.env.APPEND_CONCURRENCY = '1';
  assert.equal(getAppendConcurrency(), 1);
});

test('mapLimit preserves order with varying delays', async () => {
  const settled = await mapLimit([30, 10, 20, 5], 2, async (ms, i) => {
    await delay(ms);
    return i;
  });
  assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.deepEqual(settled.map((s) => s.value), [0, 1, 2, 3]);
});

test('mapLimit keeps allSettled shapes and order on mixed success/failure', async () => {
  const settled = await mapLimit([0, 1, 2], 2, async (x) => {
    await delay(5);
    if (x === 1) throw new Error('boom-1');
    return x * 10;
  });
  assert.equal(settled[0].status, 'fulfilled');
  assert.equal(settled[0].value, 0);
  assert.equal(settled[1].status, 'rejected');
  assert.match(settled[1].reason?.message || String(settled[1].reason), /boom-1/);
  assert.equal(settled[2].status, 'fulfilled');
  assert.equal(settled[2].value, 20);
});

test('mapLimit caps concurrency at N', async () => {
  let active = 0;
  let maxActive = 0;
  const settled = await mapLimit([0, 1, 2, 3, 4, 5], 2, async (x) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await delay(15);
      return x;
    } finally {
      active--;
    }
  });
  assert.deepEqual(settled.map((s) => s.value), [0, 1, 2, 3, 4, 5]);
  assert.ok(maxActive <= 2, `max concurrency ${maxActive} exceeds cap 2`);
});

test('mapLimit with N=1 runs serially in order', async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  const settled = await mapLimit(['a', 'b', 'c'], 1, async (x) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(5);
    order.push(x);
    active--;
    return x;
  });
  assert.deepEqual(settled.map((s) => s.value), ['a', 'b', 'c']);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(maxActive, 1);
});

test('mapLimit with N<=0/invalid is unlimited (fully parallel, as before)', async () => {
  for (const n of [0, -1, NaN, 'bogus']) {
    let active = 0;
    let maxActive = 0;
    const size = 5;
    const settled = await mapLimit(Array.from({ length: size }, (_, i) => i), n, async (x) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await delay(15);
        return x;
      } finally {
        active--;
      }
    });
    assert.deepEqual(settled.map((s) => s.value), [0, 1, 2, 3, 4]);
    assert.equal(maxActive, size, `n=${String(n)} should be fully parallel, got max ${maxActive}`);
  }
});

test('mapLimit on empty list resolves to []', async () => {
  assert.deepEqual(await mapLimit([], 2, async () => 1), []);
  assert.deepEqual(await mapLimit([], 0, async () => 1), []);
});
