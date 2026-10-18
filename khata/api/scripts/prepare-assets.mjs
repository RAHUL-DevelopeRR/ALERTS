// Prepares the Workers static-assets directory (../app/dist-web) for `wrangler dev` / `wrangler deploy` / vitest:
//  - always copies web/_headers into it (the security headers: CSP, nosniff, Referrer-Policy, Permissions-Policy);
//  - if the web app has not been built yet (no index.html), writes a placeholder page so the Worker still runs.
// It never builds, overwrites or deletes the real web app (`cd khata/app && npx vite build --mode web` does that).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(api, '../app/dist-web');
mkdirSync(dir, { recursive: true });
copyFileSync(resolve(api, 'web/_headers'), resolve(dir, '_headers'));
const index = resolve(dir, 'index.html');
if (!existsSync(index)) {
  writeFileSync(
    index,
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="kk-placeholder" content="1">
<title>Kadan Kanakku</title>
</head>
<body>
<h1>Kadan Kanakku</h1>
<p>The web app has not been built yet. Run <code>cd khata/app &amp;&amp; npx vite build --mode web</code>, then deploy again.</p>
</body>
</html>
`,
  );
}
