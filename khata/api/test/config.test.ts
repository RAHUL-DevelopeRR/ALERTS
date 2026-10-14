import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MAX_PUSH_ROWS } from '../../shared/protocol';
import app from '../src/index';
import type { Bindings } from '../src/env';
import { customer, entry, ORIGIN, owner, push } from './helpers';

async function direct(bindings: Partial<Bindings>, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}/v1${path}`, init), { DB: env.DB, ...bindings } as Bindings, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Wraps a D1 binding to count executed statements and the largest number of bound parameters. */
function countingDb(db: D1Database) {
  const stats = { queries: 0, roundTrips: 0, maxParams: 0 };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(t, k) {
        if (k === 'bind')
          return (...args: unknown[]) => {
            stats.maxParams = Math.max(stats.maxParams, args.length);
            return wrap(t.bind(...args));
          };
        if (k === 'first' || k === 'all' || k === 'run' || k === 'raw')
          return (...a: unknown[]) => {
            stats.queries++;
            stats.roundTrips++;
            return (t[k] as (...x: unknown[]) => unknown)(...a);
          };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  const wrapped = {
    prepare: (q: string) => wrap(db.prepare(q)),
    batch: (stmts: D1PreparedStatement[]) => {
      stats.queries += stmts.length;
      stats.roundTrips++;
      return db.batch(stmts.map((s) => real.get(s) ?? s));
    },
    exec: (q: string) => db.exec(q),
  } as unknown as D1Database;
  return { db: wrapped, stats };
}

describe('configuration', () => {
  it('missing PEPPER -> 500 misconfigured on every route but /health', async () => {
    const h = await direct({}, '/health');
    expect(h).toEqual({ status: 200, body: { ok: true } });
    const me = await direct({}, '/me', { headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' } });
    expect(me).toEqual({ status: 500, body: { error: 'misconfigured' } });
    const p = await direct({ SETUP_KEY: 'k' }, '/setup', { method: 'POST', headers: { 'X-Setup-Key': 'k' } });
    expect(p).toEqual({ status: 500, body: { error: 'misconfigured' } });
  });

  it('missing SETUP_KEY -> /setup answers 404', async () => {
    const r = await direct({ PEPPER: 'test-pepper' }, '/setup', { method: 'POST', headers: { 'X-Setup-Key': '' } });
    expect(r).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('a 20-row push stays inside the D1 query and parameter budget', async () => {
    const o = await owner();
    const k = customer();
    await push(o.token, { customers: [k] });
    await push(o.token, { customers: [{ ...k, archived_at: new Date().toISOString() }] });
    const { db, stats } = countingDb(env.DB);
    const entries = Array.from({ length: MAX_PUSH_ROWS }, () => entry(k.id, 'GIVE', 100));
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`${ORIGIN}/v1/sync/push`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customers: [], entries }),
      }),
      { ...env, DB: db } as unknown as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { status: string }[] };
    expect(body.results.every((r) => r.status === 'stored')).toBe(true);
    expect(stats.queries).toBeLessThan(50);
    expect(stats.maxParams).toBeLessThan(100);
    expect(stats.roundTrips).toBeLessThanOrEqual(3); // auth batch, pre-check batch, write batch
    // a resend: everything 'already', plus the one seq lookup
    const { db: db2, stats: stats2 } = countingDb(env.DB);
    const ctx2 = createExecutionContext();
    const res2 = await app.fetch(
      new Request(`${ORIGIN}/v1/sync/push`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customers: [], entries }),
      }),
      { ...env, DB: db2 } as unknown as Bindings,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    const body2 = (await res2.json()) as { results: { status: string }[] };
    expect(body2.results.every((r) => r.status === 'already')).toBe(true);
    expect(stats2.roundTrips).toBeLessThanOrEqual(3);
  });
});
