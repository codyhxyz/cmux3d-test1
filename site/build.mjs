import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
await stampBuildVersion(dist);

// A CDN or zone setting can override Cache-Control (this one stamps four hours on
// static assets), so correctness cannot rest on headers alone. Versioned URLs make
// a stale asset impossible: a new build is a new URL.
async function stampBuildVersion(directory) {
  const appDir = path.join(directory, 'app');
  const names = (await readdir(appDir)).filter((name) => name.endsWith('.js'));
  const sources = new Map();
  for (const name of names) sources.set(name, await readFile(path.join(appDir, name), 'utf8'));

  const digest = createHash('sha256');
  for (const name of [...names].sort()) digest.update(name).update(sources.get(name));
  digest.update(await readFile(path.join(directory, 'styles.css')));
  const version = digest.digest('hex').slice(0, 12);

  // Query strings, not renamed files, so the module graph keeps resolving by path.
  const versioned = (source) => source
    .replace(/(from\s+['"])(\.{0,2}\/[^'"?]+\.m?js)(['"])/g, `$1$2?v=${version}$3`)
    .replace(/(import\s*\(\s*['"])(\.{0,2}\/[^'"?]+\.m?js)(['"])/g, `$1$2?v=${version}$3`);

  for (const name of names) await writeFile(path.join(appDir, name), versioned(sources.get(name)));

  const indexPath = path.join(directory, 'index.html');
  const index = (await readFile(indexPath, 'utf8'))
    .replace(/(<script[^>]+src=")(\/app\/[^"?]+)(")/g, `$1$2?v=${version}$3`)
    .replace(/(<link[^>]+href=")(\/styles\.css)(")/g, `$1$2?v=${version}$3`);
  await writeFile(indexPath, index);
  console.log(`Stamped build ${version}`);
}

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
