const test = require('node:test');
const assert = require('node:assert');
const { Semaphore } = require('../semaphore');

test('Semaphore enforces max concurrency and drains queue', async () => {
  const sem = new Semaphore(2);
  let inFlight = 0;
  let maxObserved = 0;

  const task = async () => {
    await sem.acquire();
    inFlight++;
    maxObserved = Math.max(maxObserved, inFlight);
    // simulate async work
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    sem.release();
  };

  await Promise.all([task(), task(), task(), task()]);

  assert.strictEqual(maxObserved, 2);
  assert.strictEqual(inFlight, 0);
});

test('Semaphore releases allow queued tasks to proceed in order', async () => {
  const sem = new Semaphore(1);
  const order = [];

  const task = async (id, delay) => {
    await sem.acquire();
    order.push(`start-${id}`);
    await new Promise((r) => setTimeout(r, delay));
    order.push(`end-${id}`);
    sem.release();
  };

  await Promise.all([task(1, 5), task(2, 1), task(3, 1)]);

  assert.deepStrictEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
});
