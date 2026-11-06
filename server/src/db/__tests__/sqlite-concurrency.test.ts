import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEngine } from '../init.js';
import type { TxQueryFn } from '../types.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

beforeEach(async () => {
  await getEngine().query('CREATE TABLE transaction_isolation_test (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');
});

afterEach(async () => {
  await getEngine().query('DROP TABLE transaction_isolation_test');
});

describe('SQLite async transaction isolation', () => {
  it('keeps a concurrent request write outside a transaction that rolls back', async () => {
    const engine = getEngine();
    const entered = gate();
    const resume = gate();
    const failing = engine.withTransaction(async tx => {
      await tx("INSERT INTO transaction_isolation_test VALUES ('rolled-back', 1)");
      entered.release();
      await resume.promise;
      throw new Error('rollback this request');
    });
    await entered.promise;
    const independent = engine.query("INSERT INTO transaction_isolation_test VALUES ('kept', 2)");
    const settled = Promise.allSettled([failing, independent]);
    resume.release();
    expect((await settled).map(result => result.status)).toEqual(['rejected', 'fulfilled']);
    expect((await engine.query('SELECT * FROM transaction_isolation_test')).rows).toEqual([{ id: 'kept', value: 2 }]);
  });

  it('serializes overlapping read-modify-write transactions', async () => {
    const engine = getEngine();
    await engine.query("INSERT INTO transaction_isolation_test VALUES ('counter', 0)");
    await Promise.all(Array.from({ length: 12 }, () => engine.withTransaction(async tx => {
      const value = (await tx<{ value: number }>("SELECT value FROM transaction_isolation_test WHERE id='counter'")).rows[0].value;
      await tx("UPDATE transaction_isolation_test SET value=$1 WHERE id='counter'", [value + 1]);
    })));
    expect((await engine.query('SELECT value FROM transaction_isolation_test')).rows).toEqual([{ value: 12 }]);
  });

  it('does not expose an uncommitted row to an outside async or sync query', async () => {
    const engine = getEngine();
    const entered = gate();
    const resume = gate();
    const transaction = engine.withTransaction(async tx => {
      await tx("INSERT INTO transaction_isolation_test VALUES ('pending', 1)");
      entered.release();
      await resume.promise;
      await tx("UPDATE transaction_isolation_test SET value=2 WHERE id='pending'");
    });
    await entered.promise;
    expect(() => engine.querySync('SELECT * FROM transaction_isolation_test')).toThrow('another SQLite transaction');
    const read = engine.query('SELECT * FROM transaction_isolation_test');
    resume.release();
    await transaction;
    expect((await read).rows).toEqual([{ id: 'pending', value: 2 }]);
  });

  it('rejects a transaction query used after its transaction ended', async () => {
    let escaped!: TxQueryFn;
    await getEngine().withTransaction(async tx => { escaped = tx; });
    await expect(escaped("INSERT INTO transaction_isolation_test VALUES ('late', 1)")).rejects.toThrow('already finished');
    expect((await getEngine().query('SELECT * FROM transaction_isolation_test')).rows).toEqual([]);
  });
});
