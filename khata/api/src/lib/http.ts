import type { Context } from 'hono';
import type { ApiError, Envelope } from '../../../shared/protocol';
import type { AppEnv } from '../env';

export type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses the JSON body; `undefined` when it is missing or malformed. An empty body reads as {}. */
export async function readJson(c: Context<AppEnv>): Promise<unknown> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return undefined;
  }
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function fail(c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 413 | 429 | 500 | 503, error: string, extra?: Omit<ApiError, 'error'>) {
  return c.json<ApiError>({ error, ...extra }, status);
}

export const badRequest = (c: Context<AppEnv>, message?: string) =>
  fail(c, 400, 'bad_request', message ? { message } : undefined);

/** server_time + sync_epoch for authenticated responses. */
export function envelope(c: Context<AppEnv>, now: Date): Envelope {
  return { server_time: now.toISOString(), sync_epoch: c.get('shop').sync_epoch };
}
