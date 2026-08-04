import { isPageActive, onPageActivity } from './activity.js';
import { pairingUrl, parseFragment } from './connection-config.js';
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
import { FACETS } from './facets.js';
import { herdrMetadata } from './herdr.js';
import { createHandTracking } from './hand-tracking.js';
import { trackKeyboardInset } from './keyboard-inset.js';
import { createKeyRow } from './key-row.js';
import { qrSvg } from './qr.js';
import { startShader } from './shader.js';
import { momentumDuration, momentumSliderValue, SpaceController } from './space.js';
import { TerminalFleet } from './terminals.js';

const rig = document.getElementById('rig');
const viewport = document.getElementById('viewport');
const portList = document.getElementById('port-list');
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
const connectConnected = document.getElementById('connect-connected');
const connectHostName = document.getElementById('connect-host-name');
const connectForm = document.getElementById('connect-form');
const connectHostInput = document.getElementById('connect-host');
const connectTokenInput = document.getElementById('connect-token');
const connectMessage = document.getElementById('connect-message');
const connectSaved = document.getElementById('connect-saved');
const hostDirect = document.getElementById('host-direct');
const hostQr = document.getElementById('host-qr');
const shader = startShader(document.getElementById('shader-field'));
let herdrEvents;
let herdrRefreshing = false;
let herdrRefreshQueued = false;
const HANDOFF_KEY = 'cmux3d.handoff';
// A bounce-back this fast means the host never answered. Declared here because
// connectHost() runs while this module is still evaluating.
const HANDOFF_WINDOW_MS = 12_000;
let connectionState = 'connecting';
let connectAttempt = 0;

const fleet = new TerminalFleet({
  slot: 0,
  onConnection(open) {
    // Backgrounding closes every socket on purpose; that is not a lost host.
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

opacityInput.addEventListener('input', updateOpacity);
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
  // Returning to the tab is the natural moment to re-check; no polling needed.
  // Always re-probe: the host may have gone away while we were backgrounded.
  if (active) connectHost();
});

connectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const host = setActiveHost(connectHostInput.value, { token: connectTokenInput.value.trim() });
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
  fleet.retryNow();
  connectHost();
});
// Opening the panel or taking the command is the signal that a host may be about
// to appear; only then is it worth watching loopback.
document.getElementById('connect-panel').addEventListener('toggle', (event) => {
  if (event.newState === 'open') watchForHost();
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
updateMomentumValue(space.settleSeconds);
updateHandSensitivity();

async function connectHost() {
  // A newer attempt supersedes any probe still in flight, so tapping Connect
  // always takes effect and a slow probe never reports on the wrong computer.
  const attempt = ++connectAttempt;
  const wasConnected = connectionState === 'connected';
  try {
    if (isLoopbackHost()) desktopShells.href = hostHttp('/');
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
    const response = await fetch(hostHttp('/health'), { signal: AbortSignal.timeout(3000) });
    if (attempt !== connectAttempt) return;
    if (response.status === 401) {
      setConnectionState('unpaired');
      showMessage('That computer needs a pairing code. Copy the one printed by npm start.');
      return;
    }
    if (!response.ok) throw new Error('unreachable');

    markConnected();
    setConnectionState('connected');
    showMessage('');
    fleet.attach();
    herdrEvents?.close();
    herdrEvents = new EventSource(hostHttp('/api/herdr/events'));
    herdrEvents.addEventListener('message', refreshHerdrState);
    renderSavedHosts();
    refreshPairingCode();
  } catch {
    if (attempt === connectAttempt) setConnectionState(wasConnected ? 'lost' : 'unpaired');
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
  statusBanner.hidden = state !== 'unpaired';
  lostBanner.hidden = state !== 'lost';
  connectConnected.hidden = state !== 'connected';
  connectHostName.textContent = host.name;
  rig.querySelectorAll('[data-agent-status]').forEach((status) => {
    status.textContent = state === 'connected' ? 'unknown' : 'local';
  });
}

function showMessage(text) {
  connectMessage.textContent = text;
}

// While the install command is running there is nothing to click, so the page
// watches loopback and finishing the command becomes the whole ceremony. Bounded
// on purpose: a visitor who is not installing anything should not have their
// browser hammering localhost in the background. Chained timeouts rather than an
// interval, so a slow probe cannot stack requests on itself.
const WATCH_FOR_MS = 5 * 60_000;
let watchingUntil = 0;

function watchForHost(durationMs = WATCH_FOR_MS) {
  if (!isLoopbackHost()) return;
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

// The in-page shell's vocabulary. Connecting a computer is a command you can
// type, so the empty terminal is the onboarding instead of a dead end.
function shellCommands() {
  return {
    help(_args, { println }) {
      println('  \x1b[1mconnect\x1b[0m [address]   attach a computer and get real shells');
      println('  \x1b[1mhosts\x1b[0m               list computers this browser remembers');
      println('  \x1b[1mforget\x1b[0m <address>    remove a remembered computer');
      println('  \x1b[1mstatus\x1b[0m              show the current connection');
      println('  \x1b[1mclear\x1b[0m               clear this terminal');
      println('');
      println('To get real shells, run this on your computer:');
      println('  \x1b[1mcurl -fsSL https://codingcube.codyh.xyz/install.sh | sh\x1b[0m');
    },
    status(_args, { println }) {
      const host = activeHost();
      println(`  ${connectionState} — ${host.name} (${host.origin})`);
    },
    hosts(_args, { println }) {
      const saved = listHosts();
      if (!saved.length) {
        println('  no computers remembered yet');
        return;
      }
      for (const host of saved) println(`  ${host.origin === activeHost().origin ? '*' : ' '} ${host.name}  ${host.origin}`);
    },
    forget([address], { println }) {
      if (!address) throw new Error('usage: forget <address>');
      removeHost(address);
      renderSavedHosts();
      println(`  forgot ${address}`);
    },
    clear(_args, { term }) {
      term.write('\x1b[2J\x1b[H');
    },
    async connect([address], { println }) {
      if (!address) {
        println('  opening the connection panel…');
        document.getElementById('connect-panel').showPopover();
        return;
      }
      const host = setActiveHost(address);
      if (!host) throw new Error(`${address} is not an address I can reach`);
      println(`  connecting to ${host.name}…`);
      await connectHost();
      println(connectionState === 'connected' ? `  connected to ${host.name}` : `  ${host.name} did not answer`);
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

function renderSavedHosts() {
  const hosts = listHosts().filter((host) => host.origin !== activeHost().origin);
  connectSaved.replaceChildren(...hosts.map((host) => {
    const item = document.createElement('li');
    const use = document.createElement('button');
    use.type = 'button';
    use.innerHTML = `<strong>${host.name}</strong><small>${host.origin}</small>`;
    use.addEventListener('click', () => {
      setActiveHost(host.origin);
      location.reload();
    });
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'connect-remove';
    drop.setAttribute('aria-label', `Forget ${host.name}`);
    drop.textContent = '✕';
    drop.addEventListener('click', () => {
      removeHost(host.origin);
      renderSavedHosts();
    });
    item.append(use, drop);
    return item;
  }));
  connectSaved.hidden = !hosts.length;
}

function renderFaces() {
  for (const facet of FACETS) {
    const panel = rig.querySelector(`.panel[data-face="${facet.face}"]`);
    if (!panel) continue;
    panel.setAttribute('aria-label', `${facet.name} terminal`);
    panel.querySelector('header').innerHTML = `
      <span><i></i><strong>${facet.name}</strong><small data-session-label>${facet.code}</small></span>
      <b data-agent-status>unknown</b>
    `;
  }
}

function renderPorts() {
  for (const facet of FACETS) {
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
    portList.append(button);
  }
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
