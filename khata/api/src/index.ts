import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { AppEnv } from './env';
import { fail } from './lib/http';
import { deviceRoutes } from './routes/devices';
import { exportRoutes } from './routes/export';
import { publicRoutes } from './routes/public';
import { shopRoutes } from './routes/shop';
import { syncRoutes } from './routes/sync';

const app = new Hono<AppEnv>();

app.use(
  '/v1/*',
  cors({
    origin: ['https://localhost', 'http://localhost', 'capacitor://localhost'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Setup-Key'],
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    maxAge: 86400,
  }),
);

// Without the PEPPER secret no token or code can be checked: refuse everything except the health probe.
app.use('/v1/*', async (c, next) => {
  if (!c.env.PEPPER && c.req.path !== '/v1/health') return fail(c, 500, 'misconfigured');
  await next();
});

app.use('/v1/*', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'body_too_large' }, 413) }));

const v1 = new Hono<AppEnv>();
v1.route('/', publicRoutes);
v1.route('/', deviceRoutes);
v1.route('/', shopRoutes);
v1.route('/', syncRoutes);
v1.route('/', exportRoutes);
app.route('/v1', v1);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// Never leak stacks or SQL to clients; never log bodies or tokens.
app.onError((err, c) => {
  console.error('unhandled', c.req.method, c.req.path, err instanceof Error ? err.message : 'unknown');
  return c.json({ error: 'internal' }, 500);
});

export default app;
