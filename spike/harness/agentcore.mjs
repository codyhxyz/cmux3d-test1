// Headless driver for the AWS-side spike tests. Every command here costs money and
// runs against a live runtime, so nothing touches the network without --confirm.
//
// T-11 and T-10 run first and in that order: T-11 asks whether interactive shells work
// in us-east-1 at all, T-10 asks whether the 10-shell cap is per runtime SESSION or per
// runtime RESOURCE. A per-resource answer means one Coding Cube user per runtime and
// the whole native-shell architecture changes shape, so nothing else is worth measuring
// until both are answered.

import https from 'node:https';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  buildInvocationsUrl,
  buildPassthroughUrl,
  buildShellUrl,
  buildStopSessionUrl,
  connectShell,
  delay,
  faceShellId,
  newSessionId,
  presignShellUrl,
  presignUrl,
  resolveCredentials,
  resolveWebSocket,
  signRequest,
} from './shell-client.mjs';

const SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';
const DEFAULT_REGION = 'us-east-1';
const FACE_COUNT = 6;
const MOUNT = '/mnt/workspace';

const PROBE_COLS = 120;
const PROBE_ROWS = 32;

// Every probe below prints `key=value` lines and is read back through
// ShellConnection.probe(), which brackets the output in sentinels the PTY's echo
// cannot reproduce. Nothing here parses the raw transcript.
//
// `tty(1)` is deliberately absent: measured against this image it prints "not a tty"
// on a shell whose stdin is demonstrably /dev/pts/0 with pts/0 as its controlling
// terminal. `[ -t 0 ]`, /proc/self/fd/0 and `stty size` all agree and are used
// instead — an instrument that disagrees with three others is not a measurement.
function ptyIdentityScript(gatewayHome) {
  return [
    'printf "uid=%s\\n" "$(id -u)"',
    'printf "gid=%s\\n" "$(id -g)"',
    'printf "home=%s\\n" "$HOME"',
    'printf "term=%s\\n" "$TERM"',
    'printf "shellvar=%s\\n" "$SHELL"',
    'printf "exe=%s\\n" "$(readlink /proc/$$/exe 2>/dev/null || echo unknown)"',
    'printf "cwd=%s\\n" "$(pwd)"',
    'printf "stdintty=%s\\n" "$([ -t 0 ] && echo yes || echo no)"',
    'printf "ptsdev=%s\\n" "$(readlink /proc/self/fd/0 2>/dev/null || echo none)"',
    'printf "sttysize=%s\\n" "$(stty size 2>/dev/null || echo unknown)"',
    'printf "rawsock=%s\\n" "$([ -S "$HOME/.config/herdr/herdr.sock" ] && echo yes || echo no)"',
    `printf "pinnedsock=%s\\n" "$([ -S '${gatewayHome}/.config/herdr/herdr.sock' ] && echo yes || echo no)"`,
  ].join('; ');
}

const TESTS = new Map();

// group 'core' runs under `all`; 'slow' and 'passthrough' are opt-in because they cost
// extra microVMs or several minutes of billed idle.
function test(id, title, run, { group = 'core' } = {}) {
  TESTS.set(id, { id, title, run, group });
}

function verdict(id, name, level, measured, detail = {}) {
  return { id, title: name, verdict: level, measured, ...detail };
}

// ── T-11 ────────────────────────────────────────────────────────────────────────
// The one gate that a documentation search could not close: every AWS shell example
// is us-west-2 and ValidationException lists "the feature is not enabled in the target
// region" as a cause.
test('T-11', 'InvokeAgentRuntimeCommandShell in the target region', async (ctx) => {
  const sessionId = newSessionId();
  const attempts = [];
  for (const auth of ctx.auth === 'both' ? ['presign', 'sigv4'] : [ctx.auth]) {
    const started = Date.now();
    try {
      const shell = await openFaceShell(ctx, { shellId: 'cube-probe', sessionId, auth });
      const elapsed = Date.now() - started;
      attempts.push({ auth, ok: true, elapsedMs: elapsed, shellId: shell.shellId, reconnected: shell.reconnected });
      await shell.close();
      return verdict('T-11', 'InvokeAgentRuntimeCommandShell in the target region', 'PASS', `shell opened in ${ctx.region} via ${auth} in ${elapsed}ms`, {
        attempts,
        region: ctx.region,
        confirmedShellId: shell.shellId,
      });
    } catch (error) {
      attempts.push({ auth, ok: false, elapsedMs: Date.now() - started, ...describeShellError(error) });
    }
  }
  const failure = attempts[attempts.length - 1];
  return verdict('T-11', 'InvokeAgentRuntimeCommandShell in the target region', failure.blocker ? 'FAIL' : 'UNKNOWN', failure.summary, {
    attempts,
    remediation: failure.remediation,
  });
});

// ── T-10 ────────────────────────────────────────────────────────────────────────
// AWS says "per runtime" four times and "per runtime session" once. The only way to
// settle it is to fill one session, then try a second session on the same runtime.
test('T-10', '10-shell cap scope: per runtime session or per runtime resource', async (ctx) => {
  const sessionA = newSessionId();
  const sessionB = newSessionId();
  const open = [];
  const errors = [];

  const tryOpen = async (sessionId, face, label) => {
    try {
      const shell = await openFaceShell(ctx, { shellId: faceShellId(face), sessionId });
      open.push({ session: label, shellId: shell.shellId, shell });
      return true;
    } catch (error) {
      errors.push({ session: label, shellId: faceShellId(face), ...describeShellError(error) });
      return false;
    }
  };

  try {
    for (let face = 0; face < FACE_COUNT; face += 1) {
      if (!(await tryOpen(sessionA, face, 'A'))) break;
    }
    const openedOnA = open.length;
    if (openedOnA < FACE_COUNT) {
      // Only a cap refusal measures the cap. A 403 or a region rejection here says
      // nothing about how many shells fit, and claiming otherwise is a false FAIL.
      const last = errors[errors.length - 1];
      if (!last?.cap) {
        return verdict('T-10', '10-shell cap scope', 'UNKNOWN', `session A stopped at ${openedOnA} shells for an unrelated reason: ${last?.summary ?? 'no error recorded'}`, {
          openedOnA,
          openedOnB: 0,
          errors,
          remediation: last?.remediation ?? 'Resolve the shell-open failure above, then re-run T-10.',
        });
      }
      return verdict('T-10', '10-shell cap scope', 'FAIL', `only ${openedOnA}/${FACE_COUNT} shells opened on a single session`, {
        openedOnA,
        openedOnB: 0,
        errors,
        remediation: 'Six faces do not fit in one session. Fall back to the /ws passthrough transport or reduce the live face count.',
      });
    }

    // Push session B until it is refused. Where the wall lands is the measurement: at 6
    // more the counter is per session, at 4 more the counter spans the runtime.
    let openedOnB = 0;
    for (let face = 0; face < FACE_COUNT; face += 1) {
      if (!(await tryOpen(sessionB, face, 'B'))) break;
      openedOnB += 1;
    }

    const total = openedOnA + openedOnB;
    if (openedOnB === 0) {
      const last = errors[errors.length - 1];
      if (!last?.cap) {
        return verdict('T-10', '10-shell cap scope', 'UNKNOWN', `session B failed for an unrelated reason: ${last?.summary ?? 'no error recorded'}`, {
          openedOnA,
          openedOnB,
          errors,
          remediation: last?.remediation ?? 'Resolve the shell-open failure above, then re-run T-10.',
        });
      }
      return verdict('T-10', '10-shell cap scope', 'FAIL', `cap is PER RUNTIME RESOURCE — session B was refused with ${openedOnA} shells open on session A`, {
        openedOnA,
        openedOnB,
        maxTotalShells: total,
        errors,
        remediation: 'One concurrent Coding Cube user per runtime. Pivot to the /ws passthrough, or provision one agent runtime per user (1,000 per account, adjustable).',
      });
    }
    if (total > 10) {
      return verdict('T-10', '10-shell cap scope', 'PASS', `cap is PER RUNTIME SESSION — ${total} shells open across two sessions on one runtime`, {
        openedOnA,
        openedOnB,
        maxTotalShells: total,
        errors,
      });
    }
    return verdict('T-10', '10-shell cap scope', 'FAIL', `cap spans sessions — the runtime stopped at ${total} shells (${openedOnA} on A, ${openedOnB} on B)`, {
      openedOnA,
      openedOnB,
      maxTotalShells: total,
      errors,
      remediation: 'The counter is per runtime resource. One runtime holds one six-face cube plus four spare shells.',
    });
  } finally {
    await Promise.allSettled(open.map(({ shell }) => shell.close()));
  }
});

// ── T-08 ────────────────────────────────────────────────────────────────────────
test('T-08', 'Cold start: first invocation on a fresh session to state=ready', async (ctx) => {
  const sessionId = newSessionId();
  const started = Date.now();
  const response = await invoke(ctx, { op: 'state' }, sessionId, { timeoutMs: 300_000 });
  const elapsedMs = Date.now() - started;
  const state = response.json?.state;
  const phases = response.json?.phases ?? response.json?.boot?.phases ?? null;
  return verdict('T-08', 'Cold start', state === 'ready' ? 'PASS' : 'FAIL', `${elapsedMs}ms to state=${state ?? 'unknown'}`, {
    sessionId,
    elapsedMs,
    phases,
    mount: response.json?.mount ?? null,
    faces: response.json?.faces?.length ?? 0,
    body: response.json ?? response.body,
  });
});

// ── T-09 ────────────────────────────────────────────────────────────────────────
// The undocumented properties of the platform-spawned PTY, measured rather than
// recited. The interesting part is that the platform does NOT hand a shell the
// image's ENV HOME — it hands root's passwd home — so the raw $HOME disagreeing with
// the gateway's is expected platform behaviour, not a defect, and is reported as
// such. What must actually hold is the set of things cube-face cannot fix by itself:
// a real PTY that honours our resize, a uid that can open the gateway's socket, and
// that socket existing at the path cube-face pins HOME to.
test('T-09', 'Platform PTY identity: uid, $SHELL, $HOME, $TERM, cwd', async (ctx) => {
  const sessionId = newSessionId();
  // state first so herdr is actually running by the time the PTY stats its socket;
  // probe second for the gateway-side identity this test compares against.
  const boot = await invoke(ctx, { op: 'state' }, sessionId, { timeoutMs: 300_000 });
  const container = await invoke(ctx, { op: 'probe' }, sessionId, { timeoutMs: 300_000 });
  const gateway = container.json ?? {};
  if (!gateway.home) {
    const error = new Error('op=probe returned no gateway $HOME, so there is nothing to compare the PTY against');
    error.unmeasured = true;
    throw error;
  }

  const shell = await openFaceShell(ctx, { shellId: 'cube-probe', sessionId, resize: { cols: PROBE_COLS, rows: PROBE_ROWS } });
  try {
    const probe = await shell.probe(ptyIdentityScript(gateway.home), { timeoutMs: 45_000 });
    const values = probe.values;
    const pty = {
      uid: values.uid === undefined || values.uid === '' ? null : Number(values.uid),
      gid: values.gid === undefined || values.gid === '' ? null : Number(values.gid),
      home: values.home || null,
      term: values.term || null,
      shellVar: values.shellvar || null,
      exe: values.exe && values.exe !== 'unknown' ? values.exe : null,
      cwd: values.cwd || null,
      stdinIsTty: values.stdintty === 'yes',
      ptsDevice: values.ptsdev && values.ptsdev !== 'none' ? values.ptsdev : null,
      sttySize: values.sttysize || null,
      // Two sockets, two questions: does the platform's own $HOME reach herdr (no),
      // and does the one cube-face pins to (yes) — the second is the load-bearing one.
      socketUnderPlatformHome: values.rawsock === 'yes',
      socketUnderPinnedHome: values.pinnedsock === 'yes',
    };
    const homePinningRequired = Boolean(pty.home && pty.home !== gateway.home);

    const failures = [];
    if (pty.uid === null || !pty.home || !pty.term) failures.push('the probe did not return uid/$HOME/$TERM — nothing was measured');
    // Without a controlling PTY there is no Claude, no Pi, no vim and no reflow.
    if (!pty.stdinIsTty || !pty.ptsDevice?.startsWith('/dev/pts/')) failures.push(`the shell has no pty (stdin tty=${values.stdintty}, fd0=${values.ptsdev})`);
    // Proves the 0x04 RESIZE frame reaches the kernel, not just the socket.
    if (pty.sttySize !== `${PROBE_ROWS} ${PROBE_COLS}`) failures.push(`resize did not reach the pty: stty size=${pty.sttySize} want ${PROBE_ROWS} ${PROBE_COLS}`);
    if (pty.uid !== null && Number.isInteger(gateway.uid) && pty.uid !== gateway.uid) {
      failures.push(`uid differs: PTY ${pty.uid} vs gateway ${gateway.uid} — the face could not open the gateway's herdr socket`);
    }
    if (!pty.term) failures.push('$TERM is empty — xterm rendering has nothing to negotiate against');
    if (!pty.socketUnderPinnedHome) failures.push(`${gateway.home}/.config/herdr/herdr.sock is not a socket from inside the PTY — herdr terminal attach would fail`);

    return verdict('T-09', 'Platform PTY identity', failures.length ? 'FAIL' : 'PASS', `uid=${pty.uid} $HOME=${pty.home}${homePinningRequired ? ` (gateway ${gateway.home}; cube-face pinning is load-bearing)` : ''} TERM=${pty.term} exe=${pty.exe} pts=${pty.ptsDevice} stty=${pty.sttySize} cwd=${pty.cwd}`, {
      sessionId,
      pty,
      gateway: { uid: gateway.uid ?? null, gid: gateway.gid ?? null, home: gateway.home ?? null, term: gateway.term ?? null, shell: gateway.shell ?? null, cwd: gateway.cwd ?? null, herdrSocket: gateway.herdrSocket ?? null },
      homePinningRequired,
      bootState: boot.json?.state ?? null,
      probeText: probe.text,
      failures,
      remediation: failures.length ? 'See failures[]. cube-face pins HOME before exec\'ing herdr; if the pinned socket is missing the gateway never reached ready.' : undefined,
    });
  } finally {
    await shell.close();
  }
});

// ── T-15 ────────────────────────────────────────────────────────────────────────
// `/mnt/workspace` materialising only on the first /invocations call is documented
// platform behaviour, not a bug, so this asserts the ordering the transport now uses
// rather than the platform's raw default: invoke once (the transport needs the
// face→terminal_id map from that call anyway), then attach shells. What must hold is
// that the shell lands on a real, durable, shared session mount.
//
// The regression it still catches is the dangerous one — a workspace that silently
// runs ephemeral. That looks identical to a healthy cube until the microVM sleeps and
// the user's work is gone, so it is checked three independent ways: the gateway's own
// persistence report, the filesystem type under /mnt/workspace, and a file written by
// the shell being readable by the gateway.
test('T-15', 'Bootstrap-then-attach yields a mounted, durable workspace', async (ctx) => {
  const sessionId = newSessionId();
  const token = `t15-${Date.now()}`;

  const boot = await invoke(ctx, { op: 'state' }, sessionId, { timeoutMs: 300_000 });
  const state = boot.json ?? {};
  const durableClaim = state.persistence?.durable === true && state.mode === 'session';

  // The bootstrap call carries two obligations, and this test used to check only
  // one. It materialises the mount, and it is the sole source of the
  // face→terminal_id map — transport.js resolves terminalIdFor() from exactly this
  // array and never asks again. A gateway that answered `ready` on a durable mount
  // with `faces: []` satisfied every assertion below while leaving the transport
  // with no terminal for any face, so the ordering this test exists to protect was
  // only half-verified. Assert the payload the caller actually consumes.
  const faceEntries = Array.isArray(state.faces) ? state.faces : [];
  const mappedFaces = faceEntries.filter((entry) => typeof entry?.terminalId === 'string' && entry.terminalId);
  const faceIndexes = [...new Set(mappedFaces.map((entry) => entry.face))].sort((a, b) => a - b);
  const faceMapComplete = mappedFaces.length === FACE_COUNT && JSON.stringify(faceIndexes) === JSON.stringify([...Array(FACE_COUNT).keys()]);

  const shell = await openFaceShell(ctx, { shellId: 'cube-mount-probe', sessionId });
  let probe;
  try {
    probe = await shell.probe(mountProbeScript(token), { timeoutMs: 60_000 });
  } finally {
    await shell.close();
  }
  const values = probe.values;
  const fstype = values.fstype || null;
  // An empty fstype means /mnt/workspace is not its own mount at all — just a
  // directory on the container's overlay, which dies with the microVM.
  const ephemeralFs = !fstype || ['overlay', 'tmpfs', 'ramfs'].includes(fstype);

  // Same NFS client, same kernel page cache, so this read is coherent even under
  // acregmax=3600/nocto — the hour-long attribute cache only bites cross-client stat.
  const echo = await exec(ctx, sessionId, `cat ${MOUNT}/work/t15.txt 2>/dev/null || echo MISSING`);
  const gatewaySees = echo.stdout.trim() === token;

  // Informational control: the platform behaviour this ordering exists to work
  // around. Never part of the verdict — if AWS starts mounting for shell-only
  // sessions that is an improvement, not a regression.
  const shellOnly = await shellOnlyMountObservation(ctx).catch((error) => ({ error: error.message }));

  const failures = [];
  if (state.state !== 'ready') failures.push(`bootstrap invocation returned state=${state.state}`);
  if (!durableClaim) failures.push(`gateway reports mode=${state.mode} durable=${state.persistence?.durable}`);
  if (values.present !== 'yes') failures.push(`${MOUNT} is absent inside the attached shell`);
  if (ephemeralFs) failures.push(`${MOUNT} is ${fstype ?? 'not a separate mount'} — the workspace is silently ephemeral`);
  if (values.wrote !== token) failures.push(`the shell could not write into ${MOUNT}/work (got ${values.wrote})`);
  if (!gatewaySees) failures.push('the gateway cannot read the file the shell wrote — shell and gateway are on different filesystems');
  if (!faceMapComplete) failures.push(`the bootstrap response maps ${mappedFaces.length}/${FACE_COUNT} faces to terminal ids (faces=${JSON.stringify(faceIndexes)}) — transport.js has no terminal to attach`);

  return verdict('T-15', 'Bootstrap-then-attach yields a mounted, durable workspace', failures.length ? 'FAIL' : 'PASS', `fstype=${fstype ?? 'none'} durable=${durableClaim} shellWrote=${values.wrote === token} gatewayRead=${gatewaySees} faceMap=${mappedFaces.length}/${FACE_COUNT} (shell-only control: present=${shellOnly.present ?? '?'} fstype=${shellOnly.fstype ?? shellOnly.error ?? 'none'})`, {
    sessionId,
    mode: state.mode ?? null,
    mount: state.mount ?? null,
    faces: faceEntries,
    faceMapComplete,
    fstype,
    mountLine: values.mountline ?? null,
    probeText: probe.text,
    gatewayEcho: echo.stdout.trim(),
    shellOnlyControl: shellOnly,
    failures,
    remediation: failures.length ? 'The transport must POST /invocations for the session before opening its shells, and the container must refuse to report ready on an ephemeral mount unless CODING_CUBE_ALLOW_EPHEMERAL is set.' : undefined,
  });
});

function mountProbeScript(token) {
  return [
    `printf "present=%s\\n" "$([ -d ${MOUNT} ] && echo yes || echo no)"`,
    `printf "fstype=%s\\n" "$(awk '$2=="${MOUNT}"{print $3}' /proc/mounts | tail -n1)"`,
    `printf "mountline=%s\\n" "$(awk '$2=="${MOUNT}"' /proc/mounts | tail -n1)"`,
    `printf "wrote=%s\\n" "$(mkdir -p ${MOUNT}/work 2>/dev/null && printf '%s' '${token}' > ${MOUNT}/work/t15.txt 2>/dev/null && cat ${MOUNT}/work/t15.txt || echo FAILED)"`,
  ].join('; ');
}

// A session whose only activity is a shell connection: no /invocations, ever.
// `present` alone is not the question — the image ships /mnt/workspace as an empty
// mountpoint directory, so a bare `[ -d ]` says yes even when nothing is mounted on
// it. The fstype is what separates "session storage" from "a folder on the overlay".
async function shellOnlyMountObservation(ctx) {
  const sessionId = newSessionId();
  const shell = await openFaceShell(ctx, { shellId: 'cube-shell-only', sessionId });
  try {
    const probe = await shell.probe([
      `printf "present=%s\\n" "$([ -d ${MOUNT} ] && echo yes || echo no)"`,
      `printf "fstype=%s\\n" "$(awk '$2=="${MOUNT}"{print $3}' /proc/mounts | tail -n1)"`,
    ].join('; '), { timeoutMs: 45_000 });
    return { sessionId, present: probe.values.present ?? null, fstype: probe.values.fstype || null };
  } finally {
    await shell.close();
  }
}

// ── T-16a ───────────────────────────────────────────────────────────────────────
// The 1-hour TTL close is too slow to wait for, but a dropped socket exercises the
// same path: same sessionId + same shellId must land back on the same PTY.
test('T-16a', 'Reconnect with the same shellId reattaches the live PTY', async (ctx) => {
  const sessionId = newSessionId();
  const marker = `cube-marker-${Date.now()}`;
  let before;
  const first = await openFaceShell(ctx, { shellId: faceShellId(0), sessionId });
  try {
    // A shell variable and the shell's own pid: the service's `reconnected` flag is
    // its claim, these are the evidence. A freshly spawned PTY reports neither.
    before = await first.probe(`CUBE_T16A=${marker}; printf "marker=%s\\n" "$CUBE_T16A"; printf "pid=%s\\n" "$$"`, { timeoutMs: 30_000 });
    if (before.values.marker !== marker) throw new Error(`could not seed the PTY: marker=${before.values.marker}`);
  } finally {
    // terminate(), not close(): a clean 1000 is not what a dropped network looks like.
    if (typeof first.socket.terminate === 'function') first.socket.terminate();
    else first.socket.close(1006, 'simulated drop');
  }
  await delay(2000);

  const second = await openFaceShell(ctx, { shellId: faceShellId(0), sessionId });
  try {
    const replayed = second.output().includes(marker);
    const after = await second.probe('printf "marker=%s\\n" "$CUBE_T16A"; printf "pid=%s\\n" "$$"', { timeoutMs: 30_000 });
    const samePty = after.values.marker === marker && after.values.pid === before.values.pid;
    const failures = [];
    if (!second.reconnected) failures.push('the service did not report reconnected=true');
    if (!samePty) failures.push(`a different PTY answered: marker=${after.values.marker || 'empty'} pid=${before.values.pid} -> ${after.values.pid}`);
    return verdict('T-16a', 'Reconnect with the same shellId', failures.length ? 'FAIL' : 'PASS', `reconnected=${second.reconnected} samePty=${samePty} pid=${after.values.pid} replayedMarker=${replayed} bytesDropped=${second.bytesDropped}`, {
      sessionId,
      shellId: second.shellId,
      reconnected: second.reconnected,
      bytesDropped: second.bytesDropped,
      replayedMarker: replayed,
      pid: { before: before.values.pid ?? null, after: after.values.pid ?? null },
      failures,
    });
  } finally {
    await second.close();
  }
});

// ── T-13 ────────────────────────────────────────────────────────────────────────
test('T-13', 'Session isolation: one session cannot read another session storage', async (ctx) => {
  const sessionA = newSessionId();
  const sessionB = newSessionId();
  const token = `iso-${Date.now()}`;
  const write = await exec(ctx, sessionA, `mkdir -p ${MOUNT} && printf '%s' '${token}' > ${MOUNT}/iso.txt && cat ${MOUNT}/iso.txt`);
  // Without this, a write that never happened made "B saw nothing" look like
  // isolation. There is nothing to leak if nothing was planted.
  if (!write.stdout.includes(token)) {
    return verdict('T-13', 'Session isolation', 'UNKNOWN', 'session A never planted the file, so isolation is unmeasured', {
      sessionA,
      sessionB,
      wrote: write,
      remediation: `Confirm ${MOUNT} is writable in session A, then re-run.`,
    });
  }
  const read = await exec(ctx, sessionB, `cat ${MOUNT}/iso.txt 2>&1 || true`);
  const leaked = read.stdout.includes(token);
  return verdict('T-13', 'Session isolation', leaked ? 'FAIL' : 'PASS', leaked ? 'session B read session A files' : 'session B cannot see the file session A demonstrably wrote', {
    sessionA,
    sessionB,
    token,
    wrote: write.stdout.trim(),
    read: read.stdout.trim(),
  });
});

// ── T-12 ────────────────────────────────────────────────────────────────────────
// Eviction destroys the microVM and keeps session storage. The only honest way to see
// that from outside is to look at the two things that cannot survive it: the
// ephemeral filesystem and the kernel's uptime. The previous version watched the
// shell socket for a close instead, and reported `evictedAfter=never` on a session
// that had provably been torn down — a false negative worth more than no test at all.
//
// Three phases:
//   1. an eviction ladder — several sessions idled for different durations in
//      parallel, which brackets the real eviction window instead of asserting the
//      configured timeout;
//   2. warm restore — the wall time of the first invocation after teardown;
//   3. suppression — a HealthyBusy /ping must keep a microVM alive across an idle
//      period several times the configured timeout.
const EPHEMERAL_MARKER = '/tmp/cube-t12-marker';
const DURABLE_MARKER = `${MOUNT}/.cube/t12-marker`;
// /proc/uptime and date(1) are whole seconds, and the plant/read invocations each
// cost a round trip. Anything under this is measurement noise, not a reset.
const UPTIME_SLACK_SEC = 15;

const VM_FINGERPRINT = [
  'printf "uptime=%s\\n" "$(cut -d. -f1 /proc/uptime)"',
  'printf "bootId=%s\\n" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"',
  'printf "clock=%s\\n" "$(date +%s)"',
  `printf "ephemeral=%s\\n" "$(cat ${EPHEMERAL_MARKER} 2>/dev/null || echo MISSING)"`,
  `printf "durable=%s\\n" "$(cat ${DURABLE_MARKER} 2>/dev/null || echo MISSING)"`,
].join('; ');

function plantScript(token) {
  return [
    `mkdir -p ${MOUNT}/.cube`,
    `printf '%s' '${token}' > ${EPHEMERAL_MARKER}`,
    `printf '%s' '${token}' > ${DURABLE_MARKER}`,
    VM_FINGERPRINT,
  ].join('; ');
}

async function fingerprint(ctx, sessionId, { plant = null } = {}) {
  const { stdout } = await exec(ctx, sessionId, plant ? plantScript(plant) : VM_FINGERPRINT);
  const values = parseKeyValues(stdout);
  const uptimeSec = Number(values.uptime);
  if (!Number.isFinite(uptimeSec)) {
    const error = new Error(`fingerprint did not return /proc/uptime: ${stdout.slice(0, 200)}`);
    error.unmeasured = true;
    throw error;
  }
  return {
    at: Date.now(),
    uptimeSec,
    bootId: values.bootId || null,
    clockSec: Number(values.clock),
    ephemeral: values.ephemeral ?? null,
    durable: values.durable ?? null,
  };
}

// The whole verdict turns on this comparison, so it keys on three independent
// signals and reports which ones fired rather than trusting any single one.
function compareVm(before, after, token) {
  const idleSec = Math.max(0, Math.round((after.at - before.at) / 1000));
  // Had this been the same microVM, uptime would have grown by at least the gap.
  const uptimeReset = after.uptimeSec < before.uptimeSec + idleSec - UPTIME_SLACK_SEC;
  const bootIdChanged = Boolean(before.bootId && before.bootId !== 'unknown' && after.bootId !== before.bootId);
  const ephemeralLost = after.ephemeral !== token;
  const durableLost = after.durable !== token;
  const signals = [];
  if (ephemeralLost) signals.push('ephemeral-wiped');
  if (uptimeReset) signals.push(`uptime-reset(${before.uptimeSec}+${idleSec}s -> ${after.uptimeSec}s)`);
  if (bootIdChanged) signals.push('boot-id-changed');
  return { evicted: signals.length > 0, signals, ephemeralLost, uptimeReset, bootIdChanged, durableLost, idleSec };
}

// One rung of the ladder: boot a session, plant the markers, idle for exactly
// `waitMs` with no traffic at all, then look. Rungs run in parallel, so the ladder
// costs wall-clock max(waitMs), not the sum.
async function evictionProbe(ctx, { waitMs, token }) {
  const sessionId = newSessionId();
  const cold = await invoke(ctx, { op: 'state' }, sessionId, { timeoutMs: 300_000 });
  const before = await fingerprint(ctx, sessionId, { plant: token });
  await delay(waitMs);
  const restoreStart = Date.now();
  const restored = await invoke(ctx, { op: 'state' }, sessionId, { timeoutMs: 300_000 });
  const restoreMs = Date.now() - restoreStart;
  const after = await fingerprint(ctx, sessionId);
  return {
    sessionId,
    waitMs,
    coldState: cold.json?.state ?? null,
    restoredState: restored.json?.state ?? null,
    restoreMs,
    before,
    after,
    ...compareVm(before, after, token),
  };
}

test(
  'T-12',
  'Idle teardown, warm restore, and HealthyBusy suppression',
  async (ctx) => {
    const lifecycle = await describeLifecycle(ctx);
    const token = `t12-${Date.now()}`;
    const ladder = evictionLadder(ctx, lifecycle);
    const settled = await Promise.allSettled(ladder.map((waitMs) => evictionProbe(ctx, { waitMs, token })));
    const rungs = settled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
    const rungErrors = settled.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason?.message ?? String(entry.reason));
    if (!rungs.length) {
      return verdict('T-12', 'Idle teardown, warm restore, HealthyBusy suppression', 'UNKNOWN', `no eviction rung completed: ${rungErrors[0] ?? 'unknown'}`, { ladder, rungErrors });
    }

    const primary = rungs.reduce((longest, rung) => (rung.waitMs > longest.waitMs ? rung : longest));
    const survivedMs = rungs.filter((rung) => !rung.evicted).map((rung) => rung.waitMs);
    const evictedMs = rungs.filter((rung) => rung.evicted).map((rung) => rung.waitMs);
    const aliveThroughMs = survivedMs.length ? Math.max(...survivedMs) : null;
    const evictedByMs = evictedMs.length ? Math.min(...evictedMs) : null;

    // Suppression: re-plant (the eviction just wiped /tmp), declare the cube busy for
    // longer than the wait, then idle past the configured timeout and look again.
    const holdToken = `t12hold-${Date.now()}`;
    const holdWaitMs = ctx.holdWaitMs;
    const holdSeconds = Math.ceil(holdWaitMs / 1000) + 30;
    await invoke(ctx, { op: 'hold', seconds: holdSeconds }, primary.sessionId, { timeoutMs: 120_000 });
    const heldBefore = await fingerprint(ctx, primary.sessionId, { plant: holdToken });
    await delay(holdWaitMs);
    const heldAfter = await fingerprint(ctx, primary.sessionId);
    const held = compareVm(heldBefore, heldAfter, holdToken);

    const failures = [];
    if (!primary.evicted) failures.push(`the microVM survived ${primary.waitMs}ms of idle — raise --idle-wait above idleRuntimeSessionTimeout (${lifecycle?.idleRuntimeSessionTimeout ?? '?'}s)`);
    if (primary.evicted && primary.durableLost) failures.push('session storage did not survive the teardown — the whole premise fails here');
    if (primary.restoredState !== 'ready') failures.push(`the session did not come back ready (state=${primary.restoredState})`);
    if (held.evicted) failures.push(`HealthyBusy did not suppress teardown: evicted during a ${holdSeconds}s hold [${held.signals.join(', ')}]`);

    const window = evictedByMs === null
      ? `never — alive through ${aliveThroughMs}ms`
      : aliveThroughMs === null
        ? `by ${evictedByMs}ms (no rung idled short enough to survive)`
        : `between ${aliveThroughMs}ms and ${evictedByMs}ms`;
    return verdict(
      'T-12',
      'Idle teardown, warm restore, HealthyBusy suppression',
      failures.length ? 'FAIL' : 'PASS',
      `idle=${lifecycle?.idleRuntimeSessionTimeout ?? '?'}s evicted ${window} [${primary.signals.join(', ') || 'no signal'}] durableSurvived=${!primary.durableLost} warmRestore=${primary.restoreMs}ms holdSuppressed=${!held.evicted} over ${holdWaitMs}ms`,
      {
        configured: lifecycle,
        ladderMs: ladder,
        evictionWindowMs: { aliveThrough: aliveThroughMs, evictedBy: evictedByMs },
        warmRestoreMs: primary.restoreMs,
        durableSurvived: !primary.durableLost,
        suppression: { holdSeconds, holdWaitMs, ...held, before: heldBefore, after: heldAfter },
        rungs,
        rungErrors,
        failures,
        remediation: failures.length ? 'Check /ping HealthyBusy latching and the session-store mount report before trusting sleep/wake.' : undefined,
      },
    );
  },
  { group: 'slow' },
);

// Rungs bracket the window: the longest wait that survived and the shortest that did
// not. When the configured timeout is known the ladder straddles it deliberately —
// one rung comfortably under it, which should survive, and one comfortably over,
// which should not. A ladder where every rung is evicted only ever produces an upper
// bound, which is half a measurement.
function evictionLadder(ctx, lifecycle) {
  if (ctx.evictionLadder?.length) return ctx.evictionLadder;
  const top = ctx.idleWaitMs;
  const idleMs = Number(lifecycle?.idleRuntimeSessionTimeout) * 1000;
  const rungs = Number.isFinite(idleMs) && idleMs > 0 && idleMs * 1.2 < top
    ? [Math.round(idleMs * 0.5), Math.round(idleMs * 1.2), top]
    : [Math.round(top * 0.45), Math.round(top * 0.72), top];
  return [...new Set(rungs.map((entry) => Math.round(entry / 1000) * 1000))].sort((a, b) => a - b);
}

// Read-only control-plane call: reporting a measured eviction window without the
// configured timeout beside it invites the reader to guess which one they are seeing.
async function describeLifecycle(ctx) {
  try {
    const runtimeId = ctx.runtimeArn.split('/').pop();
    const url = `https://bedrock-agentcore-control.${ctx.region}.amazonaws.com/runtimes/${encodeURIComponent(runtimeId)}/`;
    const headers = await signRequest({ method: 'GET', url, region: ctx.region, credentials: ctx.credentials });
    const response = await httpRequest({ url, method: 'GET', headers, timeoutMs: 30_000 });
    const json = safeJson(response.body);
    if (response.statusCode >= 400 || !json) return null;
    return { ...json.lifecycleConfiguration, status: json.status, version: json.agentRuntimeVersion };
  } catch {
    // Never fail a measurement because the annotation was unavailable.
    return null;
  }
}

// ── T-14 ────────────────────────────────────────────────────────────────────────
test('T-14', 'Real agent turn recorded in ping-trace.ndjson', async (ctx) => {
  const sessionId = ctx.sessionId ?? newSessionId();
  const tracePath = `${MOUNT}/.cube/ping-trace.ndjson`;
  const trace = await exec(ctx, sessionId, `test -f ${tracePath} && tail -n 400 ${tracePath} || echo __CUBE_NO_TRACE__`);
  // "No trace file" and "trace file with no working turn" are different findings;
  // collapsing both into an empty parse hid which one was true.
  if (trace.stdout.includes('__CUBE_NO_TRACE__')) {
    return verdict('T-14', 'Real agent turn recorded', 'UNKNOWN', `no ping trace at ${tracePath} on this session`, {
      sessionId,
      remediation: `Run: node spike/harness/agentcore.mjs attach --face 1 --session ${sessionId} --confirm, drive a real Claude turn, then re-run T-14 with the same --session.`,
    });
  }
  const lines = trace.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const statuses = new Set();
  for (const entry of lines) {
    const status = entry?.payload?.data?.agent_status;
    if (status) statuses.add(status);
  }
  const observed = [...statuses].sort();
  return verdict('T-14', 'Real agent turn recorded', observed.includes('working') ? 'PASS' : 'UNKNOWN', `trace lines=${lines.length} agent_status observed=[${observed.join(', ')}]`, {
    sessionId,
    observed,
    remediation: observed.includes('working') ? undefined : `Run: node spike/harness/agentcore.mjs attach --face 1 --session ${sessionId} --confirm, drive a real Claude turn, then re-run T-14 with the same --session.`,
  });
});

// ── T-17 ────────────────────────────────────────────────────────────────────────
// Only X-Amzn-Bedrock-AgentCore-Runtime-Custom-* query params are documented as
// surviving the passthrough proxy, so the container also accepts a HELLO frame. This
// measures which mechanism actually arrives.
test('T-17', 'Passthrough /ws routing: query params vs HELLO frame', async (ctx) => {
  const viaQuery = await probePassthrough(ctx, { query: { face: '1', slot: '0' }, hello: null });
  const viaHello = await probePassthrough(ctx, { query: {}, hello: { face: 1, slot: 0 } });
  const viaCustom = await probePassthrough(ctx, { query: { 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Face': '1' }, hello: null });
  const probes = [viaQuery, viaHello, viaCustom];
  const works = probes.filter((probe) => probe.face !== null);
  // Surfaced in the one-line summary, because "face=null" three times says nothing
  // about whether the route is unrouted, unauthorised or simply not served.
  const why = works.length ? '' : ` — ${[...new Set(probes.map((probe) => probe.error ?? `close ${probe.closeCode}`))].join('; ')}`;
  return verdict('T-17', 'Passthrough /ws routing', works.length ? 'PASS' : 'FAIL', `query=${viaQuery.face} hello=${viaHello.face} customHeader=${viaCustom.face}${why}`, {
    viaQuery,
    viaHello,
    viaCustom,
  });
}, { group: 'passthrough' });

async function probePassthrough(ctx, { query, hello }) {
  const WebSocketCtor = await resolveWebSocket();
  const sessionId = newSessionId();
  const url = await presignUrl({
    url: buildPassthroughUrl({ region: ctx.region, runtimeArn: ctx.runtimeArn, query }),
    region: ctx.region,
    sessionId,
    credentials: ctx.credentials,
    signer: ctx.signer,
  });
  const socket = new WebSocketCtor(url);
  socket.binaryType = 'arraybuffer';
  let output = '';
  let lastError = null;
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve({ sessionId, ...result });
    };
    // Ref'd on purpose: an unref'd deadline lets node exit with this promise pending,
    // which reports nothing instead of "the passthrough never answered".
    const timer = setTimeout(() => finish({ face: null, output, error: `timed out after 45000ms${lastError ? `: ${lastError}` : ''}` }), 45_000);
    socket.addEventListener('open', () => {
      // The passthrough carries the container's own terminal protocol: raw PTY bytes
      // plus the 8-byte CUBE resize frame. It is not the shell channel framing.
      if (hello) socket.send(JSON.stringify(hello));
      socket.send('echo CUBEFACE=$CODING_CUBE_FACE\n');
    });
    socket.addEventListener('message', (event) => {
      output += typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      const face = output.match(/CUBEFACE=(\d+)/)?.[1];
      if (face !== undefined) finish({ face: Number(face), output });
    });
    socket.addEventListener('close', (event) => {
      finish({ face: null, output, closeCode: event?.code ?? null, error: lastError });
    });
    socket.addEventListener('error', (event) => {
      lastError = event?.error?.message ?? event?.message ?? 'socket error';
    });
  });
}

async function openFaceShell(ctx, { shellId, sessionId, auth = ctx.auth, bootstrap = null, resize = { cols: 120, rows: 32 } }) {
  const url = buildShellUrl({ region: ctx.region, runtimeArn: ctx.runtimeArn, shellId, qualifier: ctx.qualifier });
  if (auth === 'sigv4') {
    const headers = await signRequest({
      method: 'GET',
      url: url.replace(/^wss:/, 'https:'),
      region: ctx.region,
      headers: { [SESSION_HEADER]: sessionId },
      credentials: ctx.credentials,
    });
    return connectShell({ url, headers, shellId, sessionId, bootstrap, resize, connectTimeoutMs: ctx.connectTimeoutMs });
  }
  const presigned = await presignShellUrl({
    region: ctx.region,
    runtimeArn: ctx.runtimeArn,
    shellId,
    sessionId,
    qualifier: ctx.qualifier,
    credentials: ctx.credentials,
    signer: ctx.signer,
  });
  return connectShell({ url: presigned, shellId, sessionId, bootstrap, resize, connectTimeoutMs: ctx.connectTimeoutMs });
}

function describeShellError(error) {
  const body = `${error.awsMessage ?? ''} ${error.body ?? ''} ${error.message ?? ''}`;
  const match = (pattern) => pattern.test(body);
  if (match(/not enabled in the target region/i)) {
    return {
      summary: 'interactive shells are not enabled in this region',
      blocker: true,
      remediation: 'Re-run Phase 1 with --region us-west-2. The runtime, the ECR image and the role all have to move with it.',
      raw: body.trim(),
    };
  }
  if (match(/MMDSv2/i)) {
    return {
      summary: 'runtime is not MMDSv2-enabled',
      blocker: true,
      remediation: 'Recreate the runtime with metadataConfiguration.requireMMDSV2=true. Mandatory for agent runtimes since 2026-06-30.',
      raw: body.trim(),
    };
  }
  if (match(/READY state/i)) {
    return { summary: 'agent runtime is not in READY state', blocker: true, remediation: 'Wait for CreateAgentRuntime to finish, then retry.', raw: body.trim() };
  }
  if (match(/session ID is less than|33 characters/i)) {
    return { summary: 'session id rejected as too short — harness bug', blocker: true, remediation: 'runtimeSessionId has a 33-character minimum.', raw: body.trim() };
  }
  if (match(/Maximum (terminal|concurrent shell) sessions|shell (limit|quota) (reached|exceeded)/i)) {
    // `cap` is what lets T-10 tell "the service refused a 7th shell" apart from "the
    // 7th shell failed for some other reason", which are opposite findings.
    return { summary: 'shell limit reached', blocker: false, cap: true, remediation: 'This is the T-10 signal, not a failure.', raw: body.trim() };
  }
  if (error.statusCode === 403) {
    return {
      summary: 'HTTP 403 — signature or IAM rejection',
      blocker: false,
      remediation: 'Try --auth sigv4 (header auth) and --signer aws-sdk, and confirm the principal has bedrock-agentcore:InvokeAgentRuntimeCommandShell on both the runtime and the endpoint.',
      raw: body.trim(),
    };
  }
  if (error.statusCode === 424) {
    return { summary: 'HTTP 424 RuntimeClientError', blocker: false, remediation: 'The container failed to start or the image is unmountable (>53 layers with a non-numeric USER).', raw: body.trim() };
  }
  return { summary: (error.message ?? 'unknown shell failure').slice(0, 300), blocker: false, statusCode: error.statusCode ?? null, raw: body.trim() };
}

async function invoke(ctx, payload, sessionId, { timeoutMs = 120_000 } = {}) {
  const url = buildInvocationsUrl({ region: ctx.region, runtimeArn: ctx.runtimeArn, qualifier: ctx.qualifier });
  const body = JSON.stringify(payload);
  for (let attempt = 0; ; attempt += 1) {
    const headers = await signRequest({
      method: 'POST',
      url,
      region: ctx.region,
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body,
      credentials: ctx.credentials,
    });
    const response = await httpRequest({ url, method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, body, timeoutMs });
    const json = safeJson(response.body);
    // RetryableConflictException is documented as brief and expected while the service
    // provisions or tears down a session.
    const retryable = response.statusCode === 409 || response.statusCode === 429 || response.statusCode >= 500;
    if (!retryable || attempt >= 5) {
      if (response.statusCode >= 400) {
        const error = new Error(`invocations HTTP ${response.statusCode}: ${json?.message ?? response.body.slice(0, 400)}`);
        error.statusCode = response.statusCode;
        error.body = response.body;
        throw error;
      }
      return { ...response, json };
    }
    await delay(Math.min(500 * 2 ** attempt, 8000));
  }
}

// The gateway answers HTTP 200 with {error} when CODING_CUBE_SPIKE is unset, and the
// tests that read `.stdout` off that body silently measured nothing and passed. An
// exec that did not run is an unmeasured test, never a green one.
async function exec(ctx, sessionId, cmd, { timeoutMs = 300_000 } = {}) {
  const response = await invoke(ctx, { op: 'exec', cmd }, sessionId, { timeoutMs });
  const result = response.json ?? {};
  if (result.error || typeof result.stdout !== 'string') {
    const error = new Error(`exec did not run: ${result.error ?? JSON.stringify(result).slice(0, 200)}`);
    error.unmeasured = true;
    error.remediation = 'Set CODING_CUBE_SPIKE=1 on the runtime; op=exec is refused without it.';
    throw error;
  }
  return result;
}

function parseKeyValues(text) {
  const values = {};
  for (const line of String(text).split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

async function stopSession(ctx, sessionId) {
  const url = buildStopSessionUrl({ region: ctx.region, runtimeArn: ctx.runtimeArn, qualifier: ctx.qualifier });
  const body = JSON.stringify({ clientToken: crypto.randomUUID() });
  const headers = await signRequest({
    method: 'POST',
    url,
    region: ctx.region,
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
    body,
    credentials: ctx.credentials,
  });
  return httpRequest({ url, method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, body, timeoutMs: 60_000 });
}

function httpRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      { method, hostname: target.hostname, path: `${target.pathname}${target.search}`, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Interactive bridge. This is how Claude Code and Pi get authenticated inside the
// microVM, and how T-14's real agent turn is driven.
async function attach(ctx) {
  const sessionId = ctx.sessionId ?? newSessionId();
  const face = ctx.face ?? 1;
  const shellId = faceShellId(face - 1);
  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 32;
  const shell = await openFaceShell(ctx, {
    shellId,
    sessionId,
    resize: { cols, rows },
    bootstrap: ctx.bootstrap === false ? null : `exec /usr/local/bin/cube-face ${face}\n`,
  });
  process.stderr.write(`[attached · session ${sessionId} · shell ${shell.shellId} · reconnected=${shell.reconnected} · Ctrl-] to detach]\n`);

  shell.on('stdout', (bytes) => process.stdout.write(bytes));
  shell.on('stderr', (bytes) => process.stderr.write(bytes));
  const onResize = () => shell.resize(process.stdout.columns ?? cols, process.stdout.rows ?? rows);
  process.stdout.on('resize', onResize);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    if (chunk.length === 1 && chunk[0] === 0x1d) {
      shell.close(1000, 'detached');
      return;
    }
    shell.write(chunk);
  });

  const result = await shell.closed;
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  process.stdout.off('resize', onResize);
  process.stderr.write(`\n[detached · ${result.code} ${result.classification.reason} · reattach with --session ${sessionId} --face ${face}]\n`);
  return { sessionId, shellId: shell.shellId, close: result };
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split('=');
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (inline !== undefined) options[key] = inline;
    else if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else options[key] = true;
  }
  return options;
}

function usage() {
  return `Usage: node spike/harness/agentcore.mjs <command> --runtime-arn <arn> --confirm [options]

Commands:
  all                 run the core tests in blocker-first order (${[...TESTS.values()].filter((entry) => entry.group === 'core').map((entry) => entry.id).join(', ')})
  <test id>           run one test: ${[...TESTS.keys()].join(' ')}
  attach              interactive shell on a face (drives agent auth and T-14)
  invoke --op <op>    POST one /invocations op (state|snapshot|probe|hold|exec)
  stop-session        StopRuntimeSession for --session

Options:
  --runtime-arn <arn>     required; also accepted as CUBE_RUNTIME_ARN
  --region <region>       default ${DEFAULT_REGION} (or the region embedded in the ARN)
  --qualifier <name>      default DEFAULT
  --session <id>          reuse a session id (>= 33 chars) instead of minting one
  --face <1-6>            face for attach
  --auth presign|sigv4|both   default presign (both = try presign, fall back to header auth in T-11)
  --signer aws-sdk|builtin    default aws-sdk (Smithy; builtin remains only as a test oracle)
  --slow                  also run T-12, which idles for several minutes
  --passthrough           also run T-17, which opens three extra sessions
  --idle-wait <ms>        longest idle rung in T-12's eviction ladder (default 180000)
  --eviction-ladder <ms,...>  explicit T-12 idle rungs, run in parallel (default 45%/72%/100% of --idle-wait)
  --hold-wait <ms>        how long T-12 idles under a HealthyBusy hold (default 150000)
  --out <path>            results JSON (default spike/results/agentcore-<timestamp>.json)
  --dry-run               print what would be called and exit without touching AWS
  --confirm               required for anything that reaches AWS; every call is billed
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0];
  if (!command || options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const runtimeArn = options.runtimeArn ?? process.env.CUBE_RUNTIME_ARN;
  if (!runtimeArn) {
    process.stderr.write('error: --runtime-arn (or CUBE_RUNTIME_ARN) is required.\n\n' + usage());
    return 2;
  }
  const region = options.region ?? runtimeArn.split(':')[3] ?? process.env.AWS_REGION ?? DEFAULT_REGION;
  const ctx = {
    runtimeArn,
    region,
    qualifier: options.qualifier ?? 'DEFAULT',
    auth: options.auth ?? 'presign',
    signer: options.signer ?? 'aws-sdk',
    sessionId: options.session ?? null,
    face: options.face ? Number(options.face) : null,
    bootstrap: options.bootstrap !== 'false',
    connectTimeoutMs: Number(options.connectTimeout ?? 60_000),
    idleWaitMs: Number(options.idleWait ?? 180_000),
    holdWaitMs: Number(options.holdWait ?? 150_000),
    evictionLadder: options.evictionLadder
      ? String(options.evictionLadder).split(',').map((entry) => Number(entry.trim())).filter((entry) => Number.isFinite(entry) && entry > 0).sort((a, b) => a - b)
      : null,
  };

  const groups = new Set(['core', ...(options.slow ? ['slow'] : []), ...(options.passthrough ? ['passthrough'] : [])]);
  const named = [...TESTS.keys()].find((id) => id.toLowerCase() === String(command).toLowerCase());
  const plan = command === 'all' ? [...TESTS.values()].filter((entry) => groups.has(entry.group)) : named ? [TESTS.get(named)] : [];
  if (!plan.length && !['attach', 'invoke', 'stop-session'].includes(command)) {
    process.stderr.write(`unknown command "${command}"\n\n${usage()}`);
    return 2;
  }
  if (options.dryRun) {
    process.stdout.write(`DRY RUN — no AWS calls.\n  runtime : ${ctx.runtimeArn}\n  region  : ${ctx.region}\n  auth    : ${ctx.auth} (signer ${ctx.signer})\n`);
    process.stdout.write(`  invoke  : POST ${buildInvocationsUrl(ctx)}\n`);
    process.stdout.write(`  shell   : ${buildShellUrl({ ...ctx, shellId: faceShellId(0) })}\n`);
    process.stdout.write(`  tests   : ${plan.length ? plan.map((entry) => entry.id).join(', ') : command}\n`);
    return 0;
  }
  if (!options.confirm && process.env.CODING_CUBE_SPIKE_CONFIRM !== '1') {
    process.stderr.write(
      `refusing to run without --confirm.\nThis opens billed AgentCore sessions against ${ctx.runtimeArn} in ${ctx.region}.\nEvery runtime session bills memory for its whole lifetime, including idle.\n`,
    );
    return 2;
  }

  try {
    ctx.credentials = await resolveCredentials();
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 2;
  }

  if (command === 'attach') {
    await attach(ctx);
    return 0;
  }
  if (command === 'invoke') {
    const payload = options.payload ? JSON.parse(options.payload) : { op: options.op ?? 'state', ...(options.cmd ? { cmd: options.cmd } : {}), ...(options.seconds ? { seconds: Number(options.seconds) } : {}) };
    const sessionId = ctx.sessionId ?? newSessionId();
    const response = await invoke(ctx, payload, sessionId, { timeoutMs: 300_000 });
    process.stdout.write(`session ${sessionId}\n${JSON.stringify(response.json ?? response.body, null, 2)}\n`);
    return 0;
  }
  if (command === 'stop-session') {
    if (!ctx.sessionId) {
      process.stderr.write('error: stop-session needs --session\n');
      return 2;
    }
    const response = await stopSession(ctx, ctx.sessionId);
    process.stdout.write(`HTTP ${response.statusCode} ${response.body}\n`);
    return 0;
  }
  const results = [];
  for (const entry of plan) {
    const started = Date.now();
    let result;
    try {
      result = await entry.run(ctx);
    } catch (error) {
      // "I could not measure this" is not the same claim as "this is broken", and
      // reporting the second when the first is true is what costs a debugging session.
      const level = error.unmeasured ? 'UNKNOWN' : 'FAIL';
      result = verdict(entry.id, entry.title, level, (error.message ?? String(error)).slice(0, 300), {
        error: describeShellError(error),
        remediation: error.remediation,
      });
    }
    result.elapsedMs = Date.now() - started;
    results.push(result);
    process.stdout.write(`${result.id.padEnd(6)} ${result.verdict.padEnd(7)} ${result.title} — ${result.measured} [${(result.elapsedMs / 1000).toFixed(1)}s]\n`);
    if (result.remediation) process.stdout.write(`       -> ${result.remediation}\n`);
  }

  const outPath = options.out ?? fileURLToPath(new URL(`../results/agentcore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ runtimeArn: ctx.runtimeArn, region: ctx.region, auth: ctx.auth, signer: ctx.signer, ranAt: new Date().toISOString(), results }, null, 2)}\n`);
  process.stdout.write(`\nresults: ${outPath}\n`);
  return results.some((result) => result.verdict === 'FAIL') ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`error: ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
