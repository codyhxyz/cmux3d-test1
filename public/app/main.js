import { isPageActive, onPageActivity } from './activity.js';
import { DEFAULT_HOST_ORIGIN, pairingUrl, parseFragment } from './connection-config.js';
import {
  activeHost,
  connectionPlan,
  hosted,
  hostHttp,
  isLoopbackHost,
  listHosts,
  markConnected,
  removeHost,
  setActiveHost,
} from './connection.js';
import { capClipPath, capPadding, capSize, clampFaces, DEFAULT_FACES, FACETS, MAX_FACES, MIN_FACES, setFaceCount } from './facets.js';
import { herdrMetadata } from './herdr.js';
import { createHandTracking } from './hand-tracking.js';
import { trackKeyboardInset } from './keyboard-inset.js';
import { createKeyRow } from './key-row.js';
import { qrSvg } from './qr.js';
import { startShader } from './shader.js';
import { momentumDuration, momentumSliderValue, SpaceController } from './space.js';
import { TerminalFleet } from './terminals.js';
import { createOriginTransport, createSessionId, createShellTransport } from './transport.js';
import { createWorkspaceLifecycle, describeActivity, sleepPolicy } from './workspace.js';

const rig = document.getElementById('rig');
const viewport = document.getElementById('viewport');
const portList = document.getElementById('port-list');
const faceCountInput = document.getElementById('face-count');
const faceCountValue = document.getElementById('face-count-value');
const opacityInput = document.getElementById('face-opacity');
const opacityValue = document.getElementById('face-opacity-value');
const momentumInput = document.getElementById('momentum-duration');
const momentumValue = document.getElementById('momentum-duration-value');
const gravityInput = document.getElementById('zero-gravity');
const handInput = document.getElementById('hand-control');
const handStatus = document.getElementById('hand-control-status');
const handCamera = document.getElementById('hand-camera');
const handVideo = document.getElementById('hand-video');
const handSensitivity = document.getElementById('hand-sensitivity');
const handSensitivityValue = document.getElementById('hand-sensitivity-value');
const handCursors = new Map([...document.querySelectorAll('.hand-cursor')].map((cursor) => [cursor.dataset.hand, cursor]));
const statusBanner = document.getElementById('status-banner');
const lostBanner = document.getElementById('lost-banner');
const desktopShells = document.getElementById('desktop-shells');
const connectStatusLabel = document.getElementById('connect-status-label');
const connectForm = document.getElementById('connect-form');
const connectHostInput = document.getElementById('connect-host');
const connectTokenInput = document.getElementById('connect-token');
const connectMessage = document.getElementById('connect-message');
const connectSaved = document.getElementById('host-list');
const hostPolicy = document.getElementById('host-policy');
const hostDirect = document.getElementById('host-direct');
const hostQr = document.getElementById('host-qr');
const wake = document.getElementById('wake');
const wakeDot = wake.querySelector('i');
const wakeLabel = document.getElementById('wake-label');
const wakeDetail = document.getElementById('wake-detail');
const wakeNote = document.getElementById('wake-note');
const wakeElapsed = document.getElementById('wake-elapsed');
const wakeAction = document.getElementById('wake-action');
const workspaceLive = document.getElementById('workspace-live');
const shader = startShader(document.getElementById('shader-field'));
let herdrEvents;
let herdrRefreshing = false;
let herdrRefreshQueued = false;
const HANDOFF_KEY = 'coding-cube.handoff';
// A bounce-back this fast means the host never answered. Declared here because
// connectHost() runs while this module is still evaluating.
const HANDOFF_WINDOW_MS = 12_000;
// One runtimeSessionId per browser, kept across reloads: that id IS the workspace, so
// minting a fresh one would silently strand the previous machine's files. Declared above
// the fleet because building its transport reads it during module evaluation.
const AGENTCORE_SESSION_KEY = 'coding-cube.agentcore.session';
// How many faces the prism has. Read before the first transport is built because
// /prepare carries it, and applied to FACETS before anything renders or attaches.
const FACE_COUNT_KEY = 'coding-cube.faces';
let faceCount = storedFaceCount();
setFaceCount(faceCount);
let connectionState = 'connecting';
let connectAttempt = 0;
// Set while a cloud transport exists: one /prepare call that re-reads state, phase and
// busy-ness. Held here because the popover asks for it, not the transport.
let refreshWorkspace = null;
// A cancelled wake must stay cancelled through a tab switch, or returning to the page
// silently restarts the machine the user just declined to wait for.
let cloudCancelled = false;

// Six terminals retrying and a workspace waking from sleep are the same picture. This
// is the thing that tells them apart, and it must exist before the first transport is
// built, because building one already has something to say.
const lifecycle = createWorkspaceLifecycle({
  onChange: renderLifecycle,
  refresh: () => refreshWorkspace?.(),
});
lifecycle.update({ faceCount });

function agentcoreSessionId() {
  try {
    const saved = localStorage.getItem(AGENTCORE_SESSION_KEY);
    if (saved) return saved;
    const minted = createSessionId('cube-');
    localStorage.setItem(AGENTCORE_SESSION_KEY, minted);
    return minted;
  } catch {
    // Private browsing: a per-tab workspace is still better than no terminal.
    return createSessionId('cube-');
  }
}

// The minter serves the Cube, so a page that came from one is already same-origin with
// its API — which is the entire reason it serves it, since Chrome 151 refuses an https
// page's fetch to loopback outright. Resolved once and cached: it depends only on
// location.origin, which cannot change without a reload. The saved host's own address
// stays the fallback for a page served by something that is not a minter.
let cloudBase = null;
async function resolveCloudBase(fallback) {
  if (cloudBase) return cloudBase;
  try {
    const response = await fetch('/session', { signal: AbortSignal.timeout(5000) });
    // Checked on the body, not the status: a static host that answers unknown paths
    // with its index page would otherwise look like a minter.
    const body = response.ok ? await response.json().catch(() => null) : null;
    if (body?.runtimeArn) return (cloudBase = location.origin);
  } catch {
    // Not served by a minter. Fall through to whatever the saved host names.
  }
  return (cloudBase = fallback);
}

// A host is either an origin the browser can reach directly, or an AgentCore runtime
// reached through a local minter. Everything else about the Cube is identical.
function transportForHost(host = activeHost()) {
  if (host.kind !== 'agentcore') {
    refreshWorkspace = null;
    lifecycle.update({ cloud: false });
    return createOriginTransport(host);
  }
  const fallbackBase = host.origin.replace(/\/+$/, '');
  const sessionId = agentcoreSessionId();
  const ask = async (path) => {
    const base = await resolveCloudBase(fallbackBase);
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error || `minter answered ${response.status}`);
      error.code = body?.code;
      throw error;
    }
    return body;
  };
  // Every wake goes through here, so this is where the interface learns that one is
  // happening — before the first shell is minted, not after six of them have failed.
  const prepare = async () => {
    lifecycle.update({ preparing: true, error: null });
    try {
      // faces=N is the whole contract: the gateway ensures that many Herdr tabs exist
      // and answers with faces[] of that length. It never removes a tab, so shrinking
      // the prism leaves the hidden ones running with whatever is mid-task in them.
      const report = await ask(`/prepare?sessionId=${encodeURIComponent(sessionId)}&faces=${faceCount}`);
      // `busy` is the container's own report of which panes hold a working agent. A
      // minter that does not forward it leaves that unproven rather than assumed.
      adoptServedFaceCount(report);
      lifecycle.update({ preparing: false, everStarted: true, workspace: report, busy: report?.busy ?? null });
      return report;
    } catch (error) {
      lifecycle.update({ preparing: false, error: { message: error.message, auth: error.code === 'AWS_LOGIN_REQUIRED' } });
      throw error;
    }
  };
  refreshWorkspace = () => prepare().catch(() => {
    // The lifecycle already carries the failure; a rejected refresh has nothing to add.
  });
  lifecycle.update({ cloud: true, cancelled: false, error: null, workspace: null, busy: null, faces: 0, faceCount });

  return createShellTransport({
    name: host.name,
    sessionId,
    // Only the fallback for transport.faces before the first /prepare answers; the
    // gateway's faces[] supersedes it, so a later change of the setting cannot strand
    // a stale count here.
    faces: faceCount,
    mintUrl: async (shellId) => (await ask(`/mint?shellId=${encodeURIComponent(shellId)}&sessionId=${encodeURIComponent(sessionId)}`)).url,
    // Also returns the face -> terminal_id map, from the same call that materialises
    // /mnt/workspace. The transport refuses to open a shell until it resolves.
    ensureWorkspace: prepare,
  });
}

const fleet = new TerminalFleet({
  slot: 0,
  transport: transportForHost(),
  onConnection(open) {
    // How many configured faces are actually live is what separates "Waking · Opening
    // terminals…" from "Ready", and it costs no extra call to know.
    lifecycle.update({ faces: open });
    // The health check on return reports background failures without stale UI.
    if (!isPageActive()) return;
    if (!open && connectionState === 'connected') setConnectionState('lost');
    if (open && connectionState !== 'connected') setConnectionState('connected');
  },
  onCtrlChange(armed) {
    keyRow.setCtrl(armed);
  },
  commands: shellCommands(),
});
const space = new SpaceController({
  viewport,
  rig,
  onFocus(face) {
    fleet.focus(face);
    shader.setFocus(face);
    updatePortState(face);
    // The local shell is a real terminal, so the keys matter even unattached.
    if (matchMedia('(pointer: coarse)').matches) {
      document.body.classList.add('is-terminal-focused');
      keyRow.show();
    }
  },
  onMove(rotation) {
    shader.setOrbit(rotation);
  },
  onRelease() {
    shader.setFocus(null);
    updatePortState(null);
    document.body.classList.remove('is-terminal-focused');
    keyRow.hide();
    fleet.blur();
  },
});
const keyRow = createKeyRow({
  element: document.getElementById('key-row'),
  onKey: (key) => fleet.sendKey(key),
  onCtrl: (armed) => fleet.setCtrlArmed(armed),
  onRelease: () => space.release(),
  async onPaste() {
    try {
      fleet.paste(await navigator.clipboard.readText());
      keyRow.reportPaste(true);
    } catch {
      keyRow.reportPaste(false);
    }
  },
});
const hands = createHandTracking({
  video: handVideo,
  onInput: (event) => space.dragInput(event),
  onStatus(status, active) {
    handStatus.value = status;
    if (active === undefined) return;
    handInput.checked = active;
    document.body.classList.toggle('has-hand-control', active);
  },
  onFeedback({ id, state, visible, x, y }) {
    const cursor = handCursors.get(id);
    if (!cursor) return;
    cursor.hidden = !visible;
    if (!visible) return;
    cursor.dataset.state = state;
    cursor.style.setProperty('--hand-x', `${x * 100}vw`);
    cursor.style.setProperty('--hand-y', `${y * 100}vh`);
  },
});

renderFaces();
renderPorts();
renderSavedHosts();
trackKeyboardInset();
// Terminals come up immediately and are typeable with or without a computer.
fleet.start();
fleet.setWindowActive(isPageActive());
space.bind();
connectHost();
momentumInput.value = String(momentumSliderValue(space.settleSeconds));
gravityInput.checked = space.zeroGravity;
// The bounds are the measured shell ceiling, not two numbers typed into the markup.
faceCountInput.min = String(MIN_FACES);
faceCountInput.max = String(MAX_FACES);
faceCountInput.value = String(faceCount);

opacityInput.addEventListener('input', updateOpacity);
faceCountInput.addEventListener('input', () => updateFaceCountValue(clampFaces(faceCountInput.value)));
// Rebuilt on change, not input: dragging six to ten would otherwise tear the whole
// fleet down and back up four times on the way, once per step the thumb passes over.
faceCountInput.addEventListener('change', () => applyFaceCount(faceCountInput.value));
momentumInput.addEventListener('input', updateMomentum);
gravityInput.addEventListener('change', () => space.setZeroGravity(gravityInput.checked));
handSensitivity.addEventListener('input', updateHandSensitivity);
handInput.addEventListener('change', async () => {
  if (!handInput.checked) {
    hands.disable();
    return;
  }
  handInput.disabled = true;
  handInput.checked = await hands.enable(handCamera.value);
  handInput.disabled = false;
  await refreshCameras();
});
handCamera.addEventListener('change', async () => {
  handCamera.disabled = true;
  await hands.selectCamera(handCamera.value);
  handCamera.disabled = false;
});
navigator.mediaDevices?.addEventListener('devicechange', refreshCameras);
refreshCameras();
onPageActivity((active) => {
  fleet.setWindowActive(active);
  // A backgrounded tab is not asking for workspace details, and every refresh is an
  // /invocations call that resets the idle timer it is reporting on.
  if (!active) lifecycle.setDetailInterest(false);
  // Returning to the tab is the natural moment to re-check; no polling needed.
  // Always re-probe: the host may have gone away while we were backgrounded.
  if (active) connectHost();
});

connectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearCancel();
  const host = switchHost(connectHostInput.value, { token: connectTokenInput.value.trim() });
  if (!host) {
    showMessage('That does not look like an address. Try something like mymac.tailnet.ts.net.');
    return;
  }
  connectTokenInput.value = '';
  connectHost();
});
// A pasted pairing link carries both halves; split it so the user does not have to.
connectHostInput.addEventListener('input', () => {
  const { host, token } = parseFragment(connectHostInput.value.split('#')[1] || '');
  if (!host && !token) return;
  if (host) connectHostInput.value = host;
  if (token) connectTokenInput.value = token;
});
document.getElementById('connect-paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const { host, token } = parseFragment(text.split('#')[1] || '');
    if (!host && !token) {
      showMessage('That clipboard text has no pairing link in it.');
      return;
    }
    if (host) connectHostInput.value = host;
    if (token) connectTokenInput.value = token;
    connectForm.requestSubmit();
  } catch {
    showMessage("Couldn't read the clipboard — paste the link into the address field instead.");
  }
});
document.getElementById('retry-now').addEventListener('click', () => {
  clearCancel();
  fleet.retryNow();
  connectHost();
});
wakeAction.addEventListener('click', () => {
  if (lifecycle.state === 'waking') {
    cancelWake();
    return;
  }
  clearCancel();
  fleet.retryNow();
  connectHost();
});
// Opening the panel or taking the command is the signal that a host may be about
// to appear; only then is it worth watching loopback. It is also the moment the plan
// allows a workspace to be asked how it is doing — see setDetailInterest.
document.getElementById('connect-panel').addEventListener('toggle', (event) => {
  lifecycle.setDetailInterest(event.newState === 'open' && connectionState === 'connected');
  if (event.newState === 'open') watchForHost();
});
document.getElementById('host-add').addEventListener('click', () => {
  connectForm.hidden = !connectForm.hidden;
  if (!connectForm.hidden) connectHostInput.focus();
});
document.getElementById('install-copy').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  watchForHost();
  try {
    await navigator.clipboard.writeText(document.getElementById('install-command').textContent.trim());
    button.textContent = 'Copied';
  } catch {
    // Selecting it is the fallback when the clipboard is unavailable.
    getSelection()?.selectAllChildren(document.getElementById('install-command'));
    button.textContent = 'Select it';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 1600);
});
updateOpacity();
updateFaceCountValue(faceCount);
updateMomentumValue(space.settleSeconds);
updateHandSensitivity();

async function connectHost() {
  // A newer attempt supersedes any probe still in flight, so tapping Connect
  // always takes effect and a slow probe never reports on the wrong computer.
  const attempt = ++connectAttempt;
  const wasConnected = connectionState === 'connected';
  try {
    // The cloud's origin is a local minter, not a machine with a gateway on it, so the
    // loopback affordances below are about "this computer" specifically.
    const cloud = activeHost().kind === 'agentcore';
    // A declined wake is a decision, not a transient failure; only clearCancel() undoes it.
    if (cloud && cloudCancelled) return;
    // Chrome 151 refuses any secure page's request into the loopback address space
    // ("Permission was denied for this request to access the `loopback` address space"),
    // and Access-Control-Allow-Private-Network no longer exempts it. So a hosted page can
    // never reach the gateway that mints shell URLs — not a failure to retry, a place the
    // request cannot go. Mixed-content already has this shape, but loopback is exempt from
    // that check, so the cloud slips past it into a fetch that cannot succeed. Offer the
    // address it does live at, the same way the mixed-content branch does.
    if (cloud && location.protocol === 'https:') {
      hostDirect.href = `${DEFAULT_HOST_ORIGIN}/`;
      hostDirect.hidden = false;
      setConnectionState('unpaired');
      showMessage(`Your cloud runs on this computer, at ${DEFAULT_HOST_ORIGIN.replace(/^https?:\/\//, '')}. A secure page is not allowed to reach it, so open it there.`);
      return;
    }
    if (!cloud && isLoopbackHost()) desktopShells.href = hostHttp('/');
    const plan = connectionPlan();
    if (plan.type === 'mixed-content') {
      hostDirect.href = plan.directUrl;
      hostDirect.hidden = false;
      setConnectionState('unpaired');
      // This page is https and the host has no TLS, so it can only be reached on
      // its own address. Go there rather than making the user do it by hand. If we
      // land back here within seconds the host was unreachable, so stop and explain
      // instead of bouncing the user between two dead ends.
      if (plan.host.token && !justHandedOff(plan.host.origin)) {
        rememberHandoff(plan.host.origin);
        showMessage(`Opening ${plan.host.name} directly…`);
        location.href = plan.directUrl;
        return;
      }
      showMessage(`${plan.host.name} did not answer. It has no secure address, so it can only be opened directly.`);
      return;
    }
    hostDirect.hidden = true;

    // Re-probing a working host should not flash a failure before it resolves.
    if (!wasConnected) setConnectionState('connecting');
    // Each transport owns its own honest reachability question: /health for an origin,
    // or whether the AgentCore minter can actually sign a shell URL for the cloud.
    const probe = await fleet.transport.probe();
    if (attempt !== connectAttempt) return;
    if (probe.reason === 'unauthorized') {
      setConnectionState('unpaired');
      showMessage('That computer needs a pairing code. Copy the one printed by npm start.');
      return;
    }
    if (!probe.ok) throw new Error(probe.reason || 'unreachable');

    markConnected();
    lifecycle.update({ error: null });
    setConnectionState('connected');
    showMessage('');
    fleet.attach();
    herdrEvents?.close();
    // Herdr state rides the gateway's SSE stream. The cloud reports through /invocations
    // instead, so there is nothing here to subscribe to.
    if (!cloud) {
      herdrEvents = new EventSource(hostHttp('/api/herdr/events'));
      herdrEvents.addEventListener('message', refreshHerdrState);
    }
    renderSavedHosts();
    // The QR pairs a phone with this computer. A cloud host's origin is a minter that
    // serves no /api/host/info, so asking it is a console error on every cloud connect
    // and a question about the wrong machine either way.
    if (cloud) hostQr.hidden = true;
    else refreshPairingCode();
  } catch (error) {
    if (attempt !== connectAttempt) return;
    setConnectionState(wasConnected ? 'lost' : 'unpaired');
    // A cloud failure has a cause the user cannot possibly guess, and saying nothing
    // turns it into six terminals retrying forever. But most people who ever see this
    // are someone the link was shared with, not the operator — so name what is missing,
    // not the port it would have been on. "Failed to fetch" is what a browser reports
    // both when the helper is absent and when it refuses to reach loopback at all.
    if (activeHost().kind === 'agentcore') {
      const unreachable = /failed to fetch|networkerror|load failed/i.test(error.message);
      const message = unreachable
        ? 'The cloud runs from a helper on the computer that owns it, so it is not available in this browser.'
        : `Cloud unavailable: ${error.message}`;
      showMessage(message);
      lifecycle.update({ error: { message, auth: /aws login/i.test(error.message) } });
    }
  }
}

function setConnectionState(state) {
  connectionState = state;
  const host = activeHost();
  const labels = { connecting: 'Connecting…', unpaired: 'Not connected', connected: host.name, lost: 'Reconnecting…' };
  document.body.classList.toggle('is-unpaired', state === 'unpaired');
  document.body.classList.toggle('is-connecting', state === 'connecting');
  document.body.classList.toggle('is-lost', state === 'lost');
  document.body.classList.toggle('is-connected', state === 'connected');
  connectStatusLabel.textContent = labels[state];
  lifecycle.update({ cloud: host.kind === 'agentcore', connection: state });
  updateBanners();
  // Only Herdr has a real agent status to report. With ordinary shells there is
  // nothing to say, and saying "unknown" on every face is noise.
  if (state !== 'connected') rig.querySelectorAll('[data-agent-status]').forEach((status) => { status.textContent = ''; });
  renderSavedHosts();
}

function showMessage(text) {
  connectMessage.textContent = text;
}

// Two surfaces narrating the same event end up contradicting each other. While the cube
// is showing real lifecycle progress, the generic banners stand down.
function updateBanners() {
  const covered = !wake.hidden;
  statusBanner.hidden = connectionState !== 'unpaired' || covered;
  lostBanner.hidden = connectionState !== 'lost' || covered;
}

function renderLifecycle(snapshot, { stateChanged } = {}) {
  // Progress belongs over the cube; Ready and Working need no surface of their own,
  // because the terminals underneath are already the answer.
  const showing = snapshot.state === 'waking' || snapshot.state === 'saving' || snapshot.state === 'attention';
  wake.hidden = !showing;
  if (showing) {
    wakeDot.dataset.tone = snapshot.tone;
    wakeLabel.textContent = snapshot.label;
    wakeDetail.textContent = snapshot.detail;
    wakeNote.textContent = snapshot.note || '';
    wakeNote.hidden = !snapshot.note;
    wakeElapsed.textContent = snapshot.elapsed ? `${snapshot.elapsed} elapsed` : '';
    wakeElapsed.hidden = !snapshot.elapsed;
    wakeAction.textContent = snapshot.action || '';
    wakeAction.hidden = !snapshot.action;
  }
  updateBanners();
  renderSavedHosts();
  // The state, never the clock: a counter ticking into a live region would interrupt
  // terminal input once a second, which is worse than saying nothing.
  if (stateChanged && snapshot.state) {
    workspaceLive.textContent = [snapshot.label, snapshot.detail, snapshot.note]
      .filter(Boolean)
      // Sentence boundaries are what a screen reader pauses on, and a detail that is
      // already a sentence must not end up with two full stops.
      .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
      .join(' ');
  }
}

// Cancel is real, and it is the only cancel that would not be a lie: nothing can
// interrupt an AgentCore boot, but the six faces can stop retrying into a machine that
// is not answering and hand the keyboard back to the local shells.
function cancelWake() {
  cloudCancelled = true;
  fleet.detach();
  lifecycle.update({ cancelled: true, preparing: false, faces: 0 });
  setConnectionState('unpaired');
  // Focus stays on the row that started this, per plan section 9.
  document.getElementById('connect-status').focus();
}

// Only an explicit request overrides a cancelled wake; returning to the tab does not.
function clearCancel() {
  if (!cloudCancelled) return;
  cloudCancelled = false;
  lifecycle.update({ cancelled: false, error: null });
}

// Keep the click's user activation: browsers use it for the native Local Network
// permission that protects Tailscale addresses. Reloading here silently denies
// that permission and also leaves the old host's sockets attached.
function switchHost(origin, options) {
  const previous = activeHost().origin;
  const host = setActiveHost(origin, options);
  if (host && host.origin !== previous) {
    fleet.detach();
    fleet.setTransport(transportForHost(host));
    herdrEvents?.close();
    herdrEvents = null;
  }
  return host;
}

// While the install command is running there is nothing to click, so the page
// watches loopback and finishing the command becomes the whole ceremony. Bounded
// on purpose: a visitor who is not installing anything should not have their
// browser hammering localhost in the background. Chained timeouts rather than an
// interval, so a slow probe cannot stack requests on itself.
const WATCH_FOR_MS = 5 * 60_000;
let watchingUntil = 0;

function watchForHost(durationMs = WATCH_FOR_MS) {
  if (activeHost().kind === 'agentcore' || !isLoopbackHost()) return;
  const alreadyWatching = watchingUntil > Date.now();
  watchingUntil = Math.max(watchingUntil, Date.now() + durationMs);
  if (alreadyWatching) return;

  const tick = async () => {
    if (connectionState === 'connected' || Date.now() > watchingUntil) {
      watchingUntil = 0;
      return;
    }
    if (isPageActive()) await connectHost();
    if (connectionState !== 'connected') setTimeout(tick, 2000);
    else watchingUntil = 0;
  };
  setTimeout(tick, 2000);
}

// Deliberately tiny. Attaching a computer is the interface's job, not something
// typed at a prompt, so nothing administrative lives in here.
function shellCommands() {
  return {
    help(_args, { println }) {
      println('  clear    clear this terminal');
    },
    clear(_args, { term }) {
      term.write('\x1b[2J\x1b[H');
    },
  };
}

function justHandedOff(origin) {
  try {
    const [last, at] = (sessionStorage.getItem(HANDOFF_KEY) || '').split('@');
    return last === origin && Date.now() - Number(at) < HANDOFF_WINDOW_MS;
  } catch {
    return false;
  }
}

function rememberHandoff(origin) {
  try {
    sessionStorage.setItem(HANDOFF_KEY, `${origin}@${Date.now()}`);
  } catch {
    // Private browsing; worst case is one extra hop.
  }
}

// The QR only exists once the host reports a tailnet address it can be reached on.
async function refreshPairingCode() {
  try {
    const info = await (await fetch(hostHttp('/api/host/info'))).json();
    if (!info.tsOrigin || !info.token) {
      hostQr.hidden = true;
      return;
    }
    const link = pairingUrl(info.webOrigin, info.tsOrigin, info.token);
    document.getElementById('host-qr-image').innerHTML = qrSvg(link);
    document.getElementById('host-qr-direct').textContent = `${info.tsOrigin}/#token=${info.token}`;
    hostQr.hidden = false;
  } catch {
    hostQr.hidden = true;
  }
}

// Every computer this browser knows, the current one marked. Switching is picking
// one from the list, which is the only mental model the panel needs to teach.
function renderSavedHosts() {
  const current = activeHost().origin;
  const hosts = listHosts();
  // Loopback on a custom port and the default entry are the same machine, so the list
  // would otherwise show "This computer" twice. The cloud's origin is a local minter
  // rather than a machine you could open a terminal on, so it is never that duplicate —
  // without this the two loopback entries hide each other, whichever one is selected.
  const sameMachine = (host) => host.kind !== 'agentcore' && isLoopbackHost(host.origin);
  const currentIsSameMachine = hosts.some((host) => sameMachine(host) && host.origin === current);
  const seen = hosts.filter((host) => {
    if (!sameMachine(host) || host.origin === current) return true;
    return !currentIsSameMachine;
  });
  connectSaved.replaceChildren(...seen.map((host) => {
    const active = host.origin === current;
    const cloud = host.kind === 'agentcore';
    const item = document.createElement('li');
    if (active) item.className = 'is-current';

    const use = document.createElement('button');
    use.type = 'button';
    use.setAttribute('aria-current', String(active));
    // A cloud workspace reports a lifecycle state; a computer you own reports where it
    // is. The cloud's origin is the local minter's port — showing it would be both
    // meaningless and wrong, because that is not where the terminals are.
    const life = cloud && active ? lifecycle.snapshot() : null;
    const subtitle = cloud
      ? (life?.state ? `<b>${escapeHtml(life.label)}</b> · ${escapeHtml(life.detail)}` : 'sleeps when idle')
      : host.origin.replace(/^https?:\/\//, '');
    const activity = cloud
      ? describeActivity({ cloud: true, connection: active ? connectionState : 'idle', lastConnected: host.lastConnected })
      : (active ? connectionLabel() : describeActivity({ cloud: false, connection: 'idle', lastConnected: host.lastConnected }));
    use.innerHTML = `<i${life?.tone ? ` data-tone="${life.tone}"` : ''}></i>`
      + `<span><strong>${host.name}</strong><small>${subtitle}</small>`
      + `${life?.note ? `<small class="host-note">${escapeHtml(life.note)}</small>` : ''}</span>`
      + `<em>${activity}</em>`;
    use.addEventListener('click', () => {
      clearCancel();
      if (active) {
        connectHost();
        return;
      }
      switchHost(host.origin);
      connectHost();
    });
    item.append(use);

    if (!host.builtIn) {
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'connect-remove';
      drop.setAttribute('aria-label', `Forget ${host.name}`);
      drop.textContent = '✕';
      drop.addEventListener('click', () => {
        removeHost(host.origin);
        renderSavedHosts();
      });
      item.append(drop);
    }
    return item;
  }));
  // Plan section 4: say the policy in plain language rather than leaving sleep to be
  // discovered. No number, because the idle timeout lives in the runtime's
  // lifecycleConfiguration and nothing reaches the browser to read it.
  const cloudActive = activeHost().kind === 'agentcore';
  hostPolicy.textContent = cloudActive ? sleepPolicy() : '';
  hostPolicy.hidden = !cloudActive;
}

// Lifecycle text can carry a message from the minter, and the row is built as markup.
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function connectionLabel() {
  return { connected: 'connected', connecting: 'connecting…', lost: 'reconnecting…', unpaired: 'select to connect' }[connectionState];
}

// The prism's shape is data: styles.css owns the transforms and each panel carries
// only its own angle, so the same rules draw a square prism and a ten-face drum.
function renderFaces() {
  const count = FACETS.length;
  rig.style.setProperty('--sides', String(FACETS.filter((facet) => !facet.cap).length));
  // Null at six faces, and an unset property is what styles.css falls back on — so the
  // square prism's caps keep the cube's exact square panel rather than a clip that
  // happens to trace it.
  setOrClear(rig, '--cap-size', capSize(count));
  setOrClear(rig, '--cap-padding', capPadding(count));
  rig.replaceChildren(...FACETS.map((facet) => {
    const panel = document.createElement('article');
    panel.className = `panel panel--${facet.cap ? 'cap' : 'side'}`;
    panel.dataset.face = String(facet.face);
    panel.style.setProperty('--panel-angle', `${facet.angle}deg`);
    // Per panel, not per rig: the two caps look at the drum from opposite sides, so at
    // an odd side count their polygons are mirror images rather than the same shape.
    if (facet.cap) setOrClear(panel, '--cap-clip', capClipPath(count, facet.angle));
    panel.setAttribute('aria-label', `${facet.name} terminal`);

    const header = document.createElement('header');
    header.innerHTML = `
      <span><i></i><strong>${facet.name}</strong><small data-session-label>${facet.code}</small></span>
      <b data-agent-status></b>
    `;
    const surface = document.createElement('div');
    surface.className = 'terminal-surface';
    // TerminalFleet.start() finds its host element by this id and no other way.
    surface.id = `terminal-${facet.face}`;

    panel.append(header, surface);
    return panel;
  }));
}

function renderPorts() {
  portList.replaceChildren(...FACETS.map((facet) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'port-button';
    button.dataset.face = String(facet.face);
    button.dataset.index = String(facet.face + 1).padStart(2, '0');
    button.setAttribute('aria-label', `Focus ${facet.name} terminal`);
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `<span><strong>${facet.name}</strong><small data-session-label>${facet.code}</small></span>`;
    button.addEventListener('click', () => {
      if (space.focused === facet.face) space.release();
      else space.focus(facet.face);
    });
    return button;
  }));
}

function storedFaceCount() {
  try {
    const saved = localStorage.getItem(FACE_COUNT_KEY);
    return saved === null ? DEFAULT_FACES : clampFaces(saved);
  } catch {
    // Private browsing; the default prism is still the right one to draw.
    return DEFAULT_FACES;
  }
}

function rememberFaceCount(count) {
  try {
    localStorage.setItem(FACE_COUNT_KEY, String(count));
  } catch {
    // Worst case the choice lasts until reload.
  }
}

// The gateway clamps out-of-range counts and answers with faces[] of the length it
// actually served, so that length — not what we asked for — is how many panes exist.
// Following it keeps a stale or hand-edited setting from leaving panels with nothing
// behind them. Deferred because this runs inside the ensureWorkspace the transport is
// still awaiting, and rebuilding the fleet underneath it would strand that open.
function adoptServedFaceCount(report) {
  const served = Array.isArray(report?.faces) ? report.faces.length : 0;
  if (!served) return;
  // Lifecycle truth changes with the gateway response, before the deferred DOM/fleet
  // rebuild: six open sockets must not briefly make a ten-face workspace look Ready.
  lifecycle.update({ faceCount: served });
  if (served !== faceCount) setTimeout(() => applyFaceCount(served, { persist: false }), 0);
}

function applyFaceCount(value, { persist = true } = {}) {
  const count = clampFaces(value);
  lifecycle.update({ faceCount: count });
  faceCountInput.value = String(count);
  updateFaceCountValue(count);
  if (persist) rememberFaceCount(count);
  if (count === faceCount && FACETS.length === count) return;

  faceCount = count;
  setFaceCount(count);
  space.release();
  renderFaces();
  renderPorts();
  rebuildTerminals();
}

// A face count change is the one moment the fleet's membership changes. TerminalFleet
// builds its terminals once, from FACETS, inside start(), and exposes no way to add or
// drop a single face — so the fleet is retired and rebuilt against the fresh panels.
// That is lossless where it matters: the Herdr pane behind each face keeps running
// whatever the browser does, and reattaching replays its screen.
// ponytail: terminals.js should own this as fleet.sync(), so main.js need not reach
// past the one-shot guard in start(). See the report accompanying this change.
function rebuildTerminals() {
  const wasAttached = fleet.attached;
  // detach() is the safe way to drop the sockets: it clears entry.ws before closing,
  // which is what makes the close handler treat each one as superseded rather than
  // scheduling a reconnect into a terminal that is about to be thrown away.
  fleet.detach();
  for (const entry of fleet.entries.values()) {
    entry.shell?.dispose();
    entry.term.dispose();
  }
  fleet.entries.clear();
  // The old host elements are gone from the DOM; start() re-observes the new ones.
  fleet.resizeObserver.disconnect();
  fleet.openCount = 0;
  fleet.focusedFace = null;
  fleet.started = false;
  fleet.start();
  fleet.setWindowActive(isPageActive());
  if (wasAttached) fleet.attach();
  lifecycle.update({ faces: 0 });
}

function setOrClear(element, property, value) {
  if (value === null) element.style.removeProperty(property);
  else element.style.setProperty(property, value);
}

function updateFaceCountValue(count) {
  faceCountValue.value = String(count);
  faceCountValue.textContent = faceCountValue.value;
  faceCountInput.setAttribute('aria-valuetext', `${count} faces`);
}

async function refreshCameras() {
  const selected = hands.cameraId() || handCamera.value;
  try {
    const devices = await hands.cameras();
    handCamera.replaceChildren(...devices.map((device, index) => new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
    if (!devices.length) handCamera.append(new Option('Default camera', ''));
    handCamera.disabled = !devices.length;
    if (devices.some((device) => device.deviceId === selected)) handCamera.value = selected;
  } catch {
    handCamera.replaceChildren(new Option('Camera list unavailable', ''));
    handCamera.disabled = true;
  }
}

async function refreshHerdrState() {
  if (herdrRefreshing) {
    herdrRefreshQueued = true;
    return;
  }

  herdrRefreshing = true;
  do {
    herdrRefreshQueued = false;
    try {
      const response = await fetch(hostHttp('/api/herdr/state'));
      if (!response.ok) continue;

      for (const { face, snapshot } of await response.json()) {
        const facet = FACETS.find((item) => item.face === face);
        const panel = rig.querySelector(`.panel[data-face="${face}"]`);
        const button = portList.querySelector(`.port-button[data-face="${face}"]`);
        if (!facet || !panel || !button) continue;

        const metadata = herdrMetadata(snapshot);
        panel.dataset.agentStatus = metadata.status;
        panel.querySelector('[data-session-label]').textContent = metadata.label;
        panel.querySelector('[data-agent-status]').textContent = metadata.status;
        button.querySelector('[data-session-label]').textContent = `${metadata.label} · ${metadata.status}`;
        button.setAttribute('aria-label', `Focus ${facet.name} terminal, ${metadata.label}, agent ${metadata.status}`);
      }
    } catch {
      // EventSource reconnects the HerdR event stream.
    }
  } while (herdrRefreshQueued);
  herdrRefreshing = false;
}

function updatePortState(face) {
  portList.querySelectorAll('.port-button').forEach((button) => {
    const active = Number(button.dataset.face) === face;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function updateOpacity() {
  const opacity = Number(opacityInput.value);
  const translucent = opacity < 1;
  rig.style.setProperty('--face-opacity', opacity);
  rig.classList.toggle('is-translucent', translucent);
  opacityValue.value = `${Math.round(opacity * 100)}%`;
  opacityValue.textContent = opacityValue.value;
}

function updateMomentum() {
  const seconds = momentumDuration(momentumInput.value);
  space.setMomentumDuration(seconds);
  updateMomentumValue(seconds);
}

function updateMomentumValue(seconds) {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  momentumValue.value = seconds < 1 ? '<1 sec' : minutes ? `${minutes} min${rounded % 60 ? ` ${rounded % 60} sec` : ''}` : `${rounded} sec`;
  momentumValue.textContent = momentumValue.value;
  momentumInput.setAttribute('aria-valuetext', momentumValue.value);
}

function updateHandSensitivity() {
  const value = Number(handSensitivity.value);
  hands.setSensitivity(value);
  handSensitivityValue.value = `${value.toFixed(1)}×`;
  handSensitivity.setAttribute('aria-valuetext', handSensitivityValue.value);
}
