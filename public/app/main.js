import { isPageActive, onPageActivity } from './activity.js';
import { companionHttp, hosted } from './connection.js';
import { FACETS } from './facets.js';
import { herdrMetadata } from './herdr.js';
import { createHandTracking } from './hand-tracking.js';
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
const companionGate = document.getElementById('companion-gate');
const companionStatus = document.getElementById('companion-status');
const companionLocal = document.getElementById('companion-local');
const shader = startShader(document.getElementById('shader-field'));
let herdrEvents;
let herdrRefreshing = false;
let herdrRefreshQueued = false;

const fleet = new TerminalFleet({ slot: 0 });
const space = new SpaceController({
  viewport,
  rig,
  onFocus(face) {
    fleet.focus(face);
    shader.setFocus(face);
    updatePortState(face);
  },
  onMove(rotation) {
    shader.setOrbit(rotation);
  },
  onRelease() {
    shader.setFocus(null);
    updatePortState(null);
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

companionLocal.href = companionHttp('/');
renderFaces();
renderPorts();
space.bind();
connectCompanion();
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
onPageActivity((active) => fleet.setWindowActive(active));
updateOpacity();
updateMomentumValue(space.settleSeconds);
updateHandSensitivity();

async function connectCompanion() {
  companionStatus.hidden = !hosted;
  try {
    const response = await fetch(companionHttp('/health'));
    if (!response.ok) throw new Error();
    fleet.start();
    fleet.setWindowActive(isPageActive());
    herdrEvents = new EventSource(companionHttp('/api/herdr/events'));
    herdrEvents.addEventListener('message', refreshHerdrState);
  } catch {
    if (!companionGate.open) companionGate.showModal();
  } finally {
    companionStatus.hidden = true;
  }
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
    button.addEventListener('click', () => space.focus(facet.face));
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
      const response = await fetch(companionHttp('/api/herdr/state'));
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
