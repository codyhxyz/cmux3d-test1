import { FACETS } from './facets.js';
import { herdrMetadata } from './herdr.js';
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
const shader = startShader(document.getElementById('shader-field'));
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

renderFaces();
renderPorts();
space.bind();
fleet.start();
const herdrEvents = new EventSource('/api/herdr/events');
herdrEvents.addEventListener('message', refreshHerdrState);
momentumInput.value = String(momentumSliderValue(space.settleSeconds));
gravityInput.checked = space.zeroGravity;
fleet.setWindowActive(document.hasFocus());

opacityInput.addEventListener('input', updateOpacity);
momentumInput.addEventListener('input', updateMomentum);
gravityInput.addEventListener('change', () => space.setZeroGravity(gravityInput.checked));
window.addEventListener('focus', () => fleet.setWindowActive(true));
window.addEventListener('blur', () => fleet.setWindowActive(false));
updateOpacity();
updateMomentumValue(space.settleSeconds);

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

async function refreshHerdrState() {
  if (herdrRefreshing) {
    herdrRefreshQueued = true;
    return;
  }

  herdrRefreshing = true;
  do {
    herdrRefreshQueued = false;
    try {
      const response = await fetch('/api/herdr/state');
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
