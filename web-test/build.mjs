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
await writeFile(path.join(dist, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self)
`);

console.log(`Built ${dist}`);
