import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(here, 'dist');
const modules = path.join(root, 'node_modules');

await rm(dist, { recursive: true, force: true });
await cp(path.join(root, 'public'), dist, { recursive: true });
await mkdir(path.join(dist, 'vendor', 'mediapipe'), { recursive: true });

for (const [source, target] of [
  ['@xterm/xterm/css/xterm.css', 'vendor/xterm.css'],
  ['@xterm/xterm/lib/xterm.mjs', 'vendor/xterm.mjs'],
  ['@xterm/addon-attach/lib/addon-attach.mjs', 'vendor/addon-attach.mjs'],
  ['@xterm/addon-fit/lib/addon-fit.mjs', 'vendor/addon-fit.mjs'],
  ['@xterm/addon-webgl/lib/addon-webgl.mjs', 'vendor/addon-webgl.mjs'],
  ['@mediapipe/tasks-vision/vision_bundle.mjs', 'vendor/mediapipe/vision_bundle.mjs'],
]) await cp(path.join(modules, source), path.join(dist, target));

await cp(
  path.join(modules, '@mediapipe/tasks-vision/wasm'),
  path.join(dist, 'vendor', 'mediapipe', 'wasm'),
  { recursive: true },
);
await writeFile(path.join(dist, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self)
`);

console.log(`Built ${dist}`);
