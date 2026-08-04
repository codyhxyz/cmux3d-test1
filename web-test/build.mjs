import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR_ASSETS } from '../src/vendor-assets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(here, 'dist');
const modules = path.join(root, 'node_modules');

await rm(dist, { recursive: true, force: true });
await cp(path.join(root, 'public'), dist, { recursive: true });
for (const [route, source] of VENDOR_ASSETS) {
  const target = path.join(dist, route.slice(1));
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(modules, source), target);
}
// Filenames are not content-hashed, so without an explicit policy browsers apply
// heuristic freshness and keep serving yesterday's app for hours after a deploy.
// `no-cache` still stores the file — it just revalidates, so updates are instant
// and unchanged files cost a 304.
await writeFile(path.join(dist, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self)
  Cache-Control: no-cache

/icons/*
  Cache-Control: public, max-age=86400

/vendor/mediapipe/*
  Cache-Control: public, max-age=604800, immutable
`);

console.log(`Built ${dist}`);
