import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const MOUNT_POLL_MS = 250;
const SYNC_MS = 2000;
// One ~110-byte line per gateway process. Compaction folds the oldest entries
// into a single carry record so the ledger cannot grow without bound on a 1 GB
// mount, and it happens by rename, which is atomic on NFSv4.
const LEDGER_MAX_ENTRIES = 500;
const LEDGER_KEEP_ENTRIES = 100;

// One id per gateway process, not per bootstrap attempt. runBootstrap() re-runs
// on every retry and again when a late mount is adopted, and a boot counter that
// counts attempts is just as wrong as one that counts none.
const PROCESS_BOOT_ID = randomUUID();

// Directory symlinks survive a `write tmp; rename tmp target` inside them. File
// symlinks do not — the rename replaces the link with a regular file and
// persistence stops silently — so the small config files are copied instead.
const DIRECTORIES = [
  ['.claude', 'home/.claude'],
  ['.pi', 'home/.pi'],
  ['.ssh', 'home/.ssh'],
  ['.coding-cube', 'home/.coding-cube'],
  ['.config/herdr/plugins', 'home/herdr/plugins'],
];

// The .config/herdr directory itself stays on the container filesystem: session
// storage does not support mknod, and herdr.sock lives there.
const FILES = [
  ['.config/herdr/config.toml', 'home/herdr/config.toml'],
  ['.config/herdr/session.json', 'home/herdr/session.json'],
  ['.gitconfig', 'home/.gitconfig'],
  ['.bash_history', 'home/.bash_history'],
];

export async function waitForMount(mountPath, timeoutMs = 30_000) {
  const startedAt = Date.now();
  const result = { path: mountPath, present: false, writable: false, directory: false, device: null, waitedMs: 0, reason: null };

  for (;;) {
    const observed = await observeMount(mountPath);
    result.directory = observed.directory;
    result.device = observed.device;
    if (observed.mounted) {
      result.present = true;
      try {
        const probe = path.join(mountPath, '.cube');
        await fs.mkdir(probe, { recursive: true });
        await fs.writeFile(path.join(probe, '.writable'), String(Date.now()));
        result.writable = true;
      } catch (error) {
        result.reason = error.message;
      }
      result.waitedMs = Date.now() - startedAt;
      return result;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      result.waitedMs = Date.now() - startedAt;
      // Documented: "The mounted path is available only at the time of agent
      // invocation, not during initialization." Report it, never fail on it.
      result.reason = observed.directory
        ? `${mountPath} is a directory on the container filesystem, not a mount, after ${result.waitedMs}ms`
        : `no mount at ${mountPath} after ${result.waitedMs}ms`;
      return result;
    }
    await sleep(MOUNT_POLL_MS);
  }
}

// Existence is not evidence: anything that mkdir -p's the mount path while the
// mount is absent — the gateway's own workdir step used to — leaves a directory
// on the writable layer that an isDirectory() check reports as session storage,
// and every persistence measurement after that is a lie. A mount is a distinct
// filesystem, so decide on st_dev against / and on /proc/mounts, which also
// catches a bind mount that shares the root device.
async function observeMount(mountPath) {
  const stats = await statOrNull(mountPath);
  if (!stats?.isDirectory()) return { directory: false, mounted: false, device: null };
  const root = await statOrNull('/');
  const mounted = (Boolean(root) && stats.dev !== root.dev) || (await inMountTable(mountPath));
  return { directory: true, mounted, device: String(stats.dev) };
}

async function inMountTable(mountPath) {
  try {
    const table = await fs.readFile('/proc/mounts', 'utf8');
    return table.split('\n').some((line) => line.split(' ')[1] === mountPath);
  } catch {
    // Not Linux, or /proc is not mounted: st_dev is the only signal available.
    return false;
  }
}

export function createSessionStore({
  home = process.env.HOME || '/home/cube',
  mount = process.env.CODING_CUBE_MOUNT || '/mnt/workspace',
  seed = process.env.CODING_CUBE_SEED || '/opt/seed/home',
  imageDigest = process.env.CODING_CUBE_IMAGE_DIGEST || null,
  log = console.error,
} = {}) {
  let mode = 'pending';
  let mountReport = { path: mount, present: false, writable: false, waitedMs: 0, reason: null };
  // `known: false` until a durable mount has actually been read. The old default
  // claimed firstBoot=true and boots=0 from nothing, so a session running
  // ephemerally — or one whose ledger could not be read — reported a confident
  // lie instead of "no idea".
  let boot = unknownBoot('no session storage has been read yet');
  let links = [];
  let syncTimer = null;
  let syncing = false;

  const durable = () => mode === 'session';
  const statePath = (name) => (durable() ? path.join(mount, '.cube', name) : path.join('/tmp', 'coding-cube', name));

  function report() {
    return {
      mode,
      mount: { ...mountReport, firstBoot: boot.firstBoot },
      boot,
      links,
      work: durable() ? path.join(mount, 'work') : null,
    };
  }

  function unknownBoot(reason) {
    return {
      schemaVersion: SCHEMA_VERSION,
      known: false,
      reason,
      bootId: PROCESS_BOOT_ID,
      imageDigest,
      imageChanged: false,
      firstBoot: null,
      firstBootAt: null,
      lastBootAt: null,
      boots: null,
    };
  }

  async function restore(mounted = mountReport) {
    mountReport = mounted;
    mode = mounted.present && mounted.writable ? 'session' : 'ephemeral';
    links = [];

    if (!durable()) {
      boot = unknownBoot(`no durable mount at ${mount}`);
      // Ephemeral is a reported outcome, not a failure: everything still works,
      // it just does not survive the microVM.
      await fs.mkdir(path.join('/tmp', 'coding-cube'), { recursive: true });
      // A boot that ran durably and then lost the mount leaves $HOME full of
      // symlinks into it. They dangle, mkdir -p on a dangling symlink is ENOENT,
      // and every retry from then on fails at the same place — so ephemeral mode
      // takes the paths back rather than writing through a link that goes nowhere.
      for (const [homeRelative] of DIRECTORIES) {
        const homePath = path.join(home, homeRelative);
        await unlinkSymlink(homePath);
        await fs.mkdir(homePath, { recursive: true });
      }
      for (const [homeRelative] of FILES) {
        const homePath = path.join(home, homeRelative);
        await unlinkSymlink(homePath);
        await seedFile(homePath, path.join(seed, homeRelative));
      }
      return report();
    }

    for (const name of ['.cube', 'home', 'home/herdr', 'work']) {
      await fs.mkdir(path.join(mount, name), { recursive: true });
    }

    for (const [homeRelative, mountRelative] of DIRECTORIES) {
      const homePath = path.join(home, homeRelative);
      const mountPath = path.join(mount, mountRelative);
      try {
        links.push({ from: homePath, to: mountPath, action: await linkDirectory(homePath, mountPath, path.join(seed, homeRelative)) });
      } catch (error) {
        log(`session store could not link ${homePath}: ${error.message}`);
        links.push({ from: homePath, to: mountPath, action: 'failed', error: error.message });
      }
    }

    for (const [homeRelative, mountRelative] of FILES) {
      const homePath = path.join(home, homeRelative);
      const mountPath = path.join(mount, mountRelative);
      try {
        if (await exists(mountPath)) await copyFile(mountPath, homePath);
        else {
          await seedFile(homePath, path.join(seed, homeRelative));
          if (await exists(homePath)) await copyFile(homePath, mountPath);
        }
      } catch (error) {
        log(`session store could not restore ${homePath}: ${error.message}`);
      }
    }

    try {
      boot = await recordBoot();
    } catch (error) {
      // Losing the count is survivable; refusing to boot over it is not.
      log(`session store could not record this boot: ${error.message}`);
      boot = unknownBoot(`boot ledger unavailable: ${error.message}`);
    }
    return report();
  }

  // The old bookkeeping was a single whole-file read-modify-write of
  // bootstrap.json, and readJson() swallowed every error into `null` — which the
  // caller then read as "never booted before". Measured: one unreadable read is
  // enough to report boots=1 firstBoot=true on a microVM that provably replaced
  // another AND to overwrite the real history with the fabricated one. That is
  // exactly the failure mode session storage invites: NFS4 with acregmax=3600
  // and nocto serves hour-stale metadata and gives no close-to-open consistency,
  // so a read that disagrees with the server is a normal event, not a corruption.
  //
  // So the count now lives in an append-only ledger. An append cannot destroy
  // what it cannot read: O_APPEND resolves the offset on the NFS server, so even
  // a completely stale client view still lands its record after the real end of
  // file. bootstrap.json stays as a human-readable summary, but it is derived,
  // never authoritative.
  async function recordBoot() {
    const directory = path.join(mount, '.cube');
    const ledgerPath = path.join(directory, 'boots.ndjson');
    const summaryPath = path.join(directory, 'bootstrap.json');
    await fs.mkdir(directory, { recursive: true });

    const ledger = await readLedger(ledgerPath);
    const legacy = await readJson(summaryPath);
    const now = Date.now();

    // Idempotent per process: a bootstrap retry, or the second restore() a late
    // mount adoption performs, must not count as another boot.
    if (!ledger.entries.some((entry) => entry.bootId === PROCESS_BOOT_ID)) {
      // A fresh mount that already holds a legacy bootstrap.json carries its
      // count forward once, so upgrading does not reset anybody's history.
      if (!ledger.entries.length && legacy.value?.boots > 0) {
        await appendLine(ledgerPath, { k: 'carry', boots: legacy.value.boots, firstBootAt: legacy.value.firstBootAt ?? null, at: now });
        ledger.entries.push({ kind: 'carry', boots: legacy.value.boots, at: legacy.value.firstBootAt ?? now, imageDigest: legacy.value.imageDigest ?? null });
      }
      await appendLine(ledgerPath, { k: 'boot', bootId: PROCESS_BOOT_ID, at: now, imageDigest });
      ledger.entries.push({ kind: 'boot', bootId: PROCESS_BOOT_ID, boots: 1, at: now, imageDigest });
    }

    const boots = ledger.entries.reduce((total, entry) => total + entry.boots, 0);
    const previous = ledger.entries.filter((entry) => entry.kind === 'boot' && entry.bootId !== PROCESS_BOOT_ID).at(-1);
    const next = {
      schemaVersion: SCHEMA_VERSION,
      known: true,
      bootId: PROCESS_BOOT_ID,
      imageDigest,
      firstBootAt: ledger.entries[0]?.at ?? now,
      lastBootAt: now,
      boots,
      // Only a ledger we could read end to end can prove nothing came before.
      firstBoot: boots === 1 && !ledger.unreadable && !legacy.unreadable,
      // A changed digest means the runtime version moved, and a version update
      // provisions a fresh filesystem — so anything we expected to find is gone.
      imageChanged: Boolean(previous && imageDigest && previous.imageDigest !== imageDigest),
      ledger: { path: ledgerPath, entries: ledger.entries.length, unreadable: ledger.unreadable, compacted: false },
    };

    if (ledger.entries.length > LEDGER_MAX_ENTRIES && !ledger.unreadable) {
      next.ledger.compacted = await compactLedger(ledgerPath, ledger.entries, boots);
    }

    // Derived, and deliberately last: if this write is lost the ledger is still
    // the truth, which is the whole point of not depending on it.
    try {
      await fs.writeFile(summaryPath, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      log(`session store could not update ${summaryPath}: ${error.message}`);
    }
    return next;
  }

  async function syncPass() {
    if (!durable() || syncing) return;
    syncing = true;
    try {
      for (const [homeRelative, mountRelative] of FILES) {
        const homePath = path.join(home, homeRelative);
        const mountPath = path.join(mount, mountRelative);
        const [homeStats, mountStats] = await Promise.all([statOrNull(homePath), statOrNull(mountPath)]);
        if (homeStats && (!mountStats || homeStats.mtimeMs > mountStats.mtimeMs)) await copyFile(homePath, mountPath);
        else if (mountStats && (!homeStats || mountStats.mtimeMs > homeStats.mtimeMs)) await copyFile(mountPath, homePath);
      }
    } catch (error) {
      log(`session store sync failed: ${error.message}`);
    } finally {
      syncing = false;
    }
  }

  return {
    statePath,
    waitForMount: (timeoutMs) => waitForMount(mount, timeoutMs),
    restore,
    async appendLog(line) {
      const target = statePath('boot.log');
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, `${line}\n`);
      } catch (error) {
        log(`session store could not append to ${target}: ${error.message}`);
      }
    },
    startSyncLoop(intervalMs = SYNC_MS) {
      if (syncTimer || !durable()) return;
      // Nothing documents whether the container gets a SIGTERM before the microVM
      // is torn down, so the only safe design is to keep the loss window short.
      syncTimer = setInterval(() => syncPass(), intervalMs);
      syncTimer.unref?.();
    },
    async flush() {
      await syncPass();
    },
    stop() {
      clearInterval(syncTimer);
      syncTimer = null;
    },
    report,
  };
}

async function linkDirectory(homePath, mountPath, seedPath) {
  const current = await lstatOrNull(homePath);
  if (current?.isSymbolicLink()) await fs.unlink(homePath);

  let action = 'linked';
  if (!(await exists(mountPath))) {
    await fs.mkdir(path.dirname(mountPath), { recursive: true });
    const source = (await exists(seedPath)) ? seedPath : (current?.isDirectory() ? homePath : null);
    if (source) {
      await copyTree(source, mountPath);
      action = 'seeded';
    } else {
      await fs.mkdir(mountPath, { recursive: true });
      action = 'created';
    }
  }

  if (current && !current.isSymbolicLink()) await fs.rm(homePath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(homePath), { recursive: true });
  await fs.symlink(mountPath, homePath);
  return action;
}

// Session storage supports no device files, FIFOs or sockets, and no hard links,
// so copy exactly the three kinds of entry it can hold.
async function copyTree(source, destination) {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
    return;
  }
  if (stats.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: stats.mode & 0o777 });
    for (const entry of await fs.readdir(source)) await copyTree(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (!stats.isFile()) return;
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stats.mode & 0o777);
  await fs.utimes(destination, stats.atime, stats.mtime);
}

async function copyFile(source, destination) {
  const stats = await fs.stat(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stats.mode & 0o777);
  // Carrying the mtime across is what stops the two-second loop from copying the
  // same file back and forth forever.
  await fs.utimes(destination, stats.atime, stats.mtime);
}

async function unlinkSymlink(target) {
  const stats = await lstatOrNull(target);
  if (stats?.isSymbolicLink()) await fs.unlink(target);
}

async function seedFile(homePath, seedPath) {
  if (await exists(homePath)) return false;
  if (!(await exists(seedPath))) return false;
  await copyFile(seedPath, homePath);
  return true;
}

// "Absent" and "there but unreadable" are different answers, and collapsing them
// into null is what let a single bad read declare a first boot.
async function readJson(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    return { value: null, unreadable: error.code !== 'ENOENT', error };
  }
  try {
    return { value: JSON.parse(text), unreadable: false, error: null };
  } catch (error) {
    return { value: null, unreadable: true, error };
  }
}

async function readLedger(file) {
  const result = { entries: [], unreadable: false };
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    result.unreadable = error.code !== 'ENOENT';
    return result;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A torn tail costs one boot, where a torn whole-file record cost all of
      // them. Note it so firstBoot cannot be claimed off an incomplete read.
      result.unreadable = true;
      continue;
    }
    if (record.k === 'carry') result.entries.push({ kind: 'carry', boots: Number(record.boots) || 0, at: record.firstBootAt ?? record.at ?? 0, imageDigest: record.imageDigest ?? null });
    else if (record.k === 'boot') result.entries.push({ kind: 'boot', bootId: record.bootId ?? null, boots: 1, at: record.at ?? 0, imageDigest: record.imageDigest ?? null });
    else result.unreadable = true;
  }
  return result;
}

// O_APPEND, one write, one line. The offset is resolved by the NFS server, so a
// client holding an hour-stale view of the file still lands after the real end.
async function appendLine(file, record) {
  await fs.appendFile(file, `${JSON.stringify(record)}\n`);
}

async function compactLedger(file, entries, boots) {
  const keep = entries.filter((entry) => entry.kind === 'boot').slice(-LEDGER_KEEP_ENTRIES);
  const carried = boots - keep.length;
  const lines = [
    JSON.stringify({ k: 'carry', boots: carried, firstBootAt: entries[0]?.at ?? Date.now(), at: Date.now() }),
    ...keep.map((entry) => JSON.stringify({ k: 'boot', bootId: entry.bootId, at: entry.at, imageDigest: entry.imageDigest })),
  ];
  const temporary = `${file}.compact-${process.pid}`;
  try {
    await fs.writeFile(temporary, `${lines.join('\n')}\n`);
    // rename is atomic on NFSv4, so an interrupted compaction can never leave a
    // half-written ledger where the whole history used to be.
    await fs.rename(temporary, file);
    return true;
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

async function exists(target) {
  return Boolean(await lstatOrNull(target));
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
