import { isPageActive, onPageActivity } from './activity.js';
import { FACETS } from './facets.js';

export const SETTLE_SECONDS = 10;
export const MAX_SETTLE_SECONDS = 300;
export const MAX_ANGULAR_SPEED = 6;
export const STOP_SPEED = 0.01;
export const DAMPING = Math.log(MAX_ANGULAR_SPEED / STOP_SPEED) / SETTLE_SECONDS;
export const MAX_DRAG_ANGULAR_SPEED = 540;
export const DRAG_STOP_SPEED = 2;
export const DRAG_DAMPING = Math.log(MAX_DRAG_ANGULAR_SPEED / DRAG_STOP_SPEED) / SETTLE_SECONDS;
const DRAG_SENSITIVITY = 0.28;
const DRAG_SAMPLE_TIMEOUT_MS = 80;
const MIN_ZOOM = 0.72;
const MAX_ZOOM = 1.42;

export function integrateDamped(position, velocity, seconds, damping = DAMPING) {
  const decay = Math.exp(-damping * seconds);
  return {
    position: position + velocity * -Math.expm1(-damping * seconds) / damping,
    velocity: velocity * decay,
  };
}

export function dragVelocity(dx, dy, milliseconds) {
  const seconds = Math.max(8, milliseconds) / 1000;
  const velocity = { x: -dy * DRAG_SENSITIVITY / seconds, y: dx * DRAG_SENSITIVITY / seconds };
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed > MAX_DRAG_ANGULAR_SPEED) {
    velocity.x *= MAX_DRAG_ANGULAR_SPEED / speed;
    velocity.y *= MAX_DRAG_ANGULAR_SPEED / speed;
  }
  return velocity;
}

export function momentumDuration(sliderValue) {
  const position = clamp(Number(sliderValue), 0, 100) / 100;
  return MAX_SETTLE_SECONDS * position / (9 - 8 * position);
}

export function momentumSliderValue(seconds) {
  const duration = clamp(Number(seconds), 0, MAX_SETTLE_SECONDS) / MAX_SETTLE_SECONDS;
  return 900 * duration / (1 + 8 * duration);
}

export class SpaceController {
  constructor({ viewport, rig, onFocus, onMove, onRelease } = {}) {
    this.viewport = viewport;
    this.rig = rig;
    this.onFocus = onFocus || (() => {});
    this.onMove = onMove || (() => {});
    this.onRelease = onRelease || (() => {});
    this.rotation = { x: -22, y: 34 };
    this.velocity = { x: 3.6, y: 4.8 };
    this.inertia = false;
    this.zoom = 1;
    this.focused = null;
    this.drag = null;
    this.frame = 0;
    this.settleSeconds = SETTLE_SECONDS;
    this.zeroGravity = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.windowActive = isPageActive();
    this.lastTick = Date.now();
    this.settleAt = this.lastTick + this.settleSeconds * 1000;
  }

  bind() {
    this.#apply();

    this.viewport.addEventListener('pointerdown', (event) => this.#pointerDown(event));
    this.viewport.addEventListener('pointermove', (event) => this.#pointerMove(event));
    this.viewport.addEventListener('pointerup', (event) => this.#pointerUp(event));
    this.viewport.addEventListener('pointercancel', (event) => this.#pointerUp(event));
    this.viewport.addEventListener('wheel', (event) => this.#wheel(event), { passive: false });

    onPageActivity((active) => this.#setWindowActive(active));
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.focused === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.release();
    }, true);

    if (!this.zeroGravity) this.velocity = { x: 0, y: 0 };
    this.#schedule();
  }

  setMomentumDuration(seconds) {
    const now = Date.now();
    this.#advance(now);
    this.settleSeconds = clamp(Number(seconds), 0, MAX_SETTLE_SECONDS);
    if (!this.zeroGravity || !this.settleSeconds) {
      this.velocity = { x: 0, y: 0 };
      this.inertia = false;
      this.#pause();
      return;
    }

    if (!Math.hypot(this.velocity.x, this.velocity.y)) this.velocity = { x: 3.6, y: 4.8 };
    this.lastTick = now;
    this.settleAt = now + this.settleSeconds * 1000;
    this.#schedule();
  }

  setZeroGravity(enabled) {
    this.zeroGravity = enabled;
    if (!enabled) {
      this.velocity = { x: 0, y: 0 };
      this.inertia = false;
      this.#pause();
      return;
    }

    const now = Date.now();
    this.velocity = { x: 3.6, y: 4.8 };
    this.inertia = false;
    this.lastTick = now;
    this.settleAt = now + this.settleSeconds * 1000;
    this.#schedule();
  }

  focus(face) {
    const facet = FACETS.find((item) => item.face === face);
    if (!facet) return;
    const now = Date.now();
    this.#advance(now);
    this.focused = face;
    this.velocity = { x: 0, y: 0 };
    this.inertia = false;
    this.#pause();
    this.rotation = { ...facet.view };
    this.zoom = 1.08;
    this.#markPanels();
    this.#apply(true);
    this.onFocus(face);
    this.#schedule();
  }

  release() {
    this.focused = null;
    this.#markPanels();
    this.onRelease();
  }

  dragInput({ type, id = 'hand', x = 0, y = 0, time = performance.now(), panelFace: startFace = null } = {}) {
    if (type === 'start') {
      if (this.drag) {
        if (this.drag.second || this.drag.id === id || typeof this.drag.id !== typeof id) return false;
        this.drag.second = { id, x, y };
        this.drag.pair = inputPair(this.drag, this.drag.second);
        this.drag.velocity = { x: 0, y: 0 };
        this.drag.time = time;
        this.drag.moved = true;
        this.drag.panelFace = null;
        return true;
      }

      const now = Date.now();
      this.#advance(now);
      this.#pause();
      this.velocity = { x: 0, y: 0 };
      this.inertia = false;
      this.drag = {
        id,
        x,
        y,
        time,
        velocity: { x: 0, y: 0 },
        distance: 0,
        moved: false,
        panelFace: startFace,
        second: null,
        pair: null,
      };
      this.rig.classList.add('is-moving');
      document.body.classList.add('is-dragging');
      return true;
    }

    if (!this.drag || (this.drag.id !== id && this.drag.second?.id !== id)) return false;

    if (type === 'move') {
      const input = this.drag.id === id ? this.drag : this.drag.second;
      const previous = this.drag.second ? this.drag.pair : { x: input.x, y: input.y, span: 0 };
      input.x = x;
      input.y = y;
      const next = this.drag.second ? inputPair(this.drag, this.drag.second) : input;
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      const spanDelta = (next.span || 0) - (previous.span || 0);

      if (this.drag.second) {
        if (previous.span > 1) this.zoom = clamp(this.zoom * next.span / previous.span, MIN_ZOOM, MAX_ZOOM);
        this.drag.pair = next;
      }
      this.drag.distance += Math.hypot(dx, dy) + Math.abs(spanDelta);
      if (this.drag.distance > 4) this.drag.moved = true;

      this.rotation.y += dx * DRAG_SENSITIVITY;
      this.rotation.x -= dy * DRAG_SENSITIVITY;
      if (dx || dy) {
        this.drag.velocity = dragVelocity(dx, dy, time - this.drag.time);
        this.drag.time = time;
      } else if (spanDelta) {
        this.drag.velocity = { x: 0, y: 0 };
        this.drag.time = time;
      }
      if (this.focused !== null) this.release();
      this.#apply();
      return true;
    }

    if (type !== 'end' && type !== 'cancel') return false;
    if (this.drag.second) {
      if (this.drag.id === id) {
        this.drag.id = this.drag.second.id;
        this.drag.x = this.drag.second.x;
        this.drag.y = this.drag.second.y;
      }
      this.drag.second = null;
      this.drag.pair = null;
      this.drag.velocity = { x: 0, y: 0 };
      this.drag.time = time;
      return true;
    }

    const { moved, panelFace, time: lastMoveTime, velocity } = this.drag;
    this.drag = null;
    document.body.classList.remove('is-dragging');

    if (type === 'end' && !moved && panelFace !== null) {
      this.focus(panelFace);
      return true;
    }

    // Tapping away is the touch equivalent of Escape, which phones do not have.
    if (type === 'end' && !moved && this.focused !== null) {
      this.release();
      return true;
    }

    const speed = Math.hypot(velocity.x, velocity.y);
    if (!this.zeroGravity || type === 'cancel' || time - lastMoveTime > DRAG_SAMPLE_TIMEOUT_MS || speed <= DRAG_STOP_SPEED) {
      this.velocity = { x: 0, y: 0 };
      this.inertia = false;
      this.#pause();
      return true;
    }

    const now = Date.now();
    this.velocity = velocity;
    this.inertia = true;
    this.lastTick = now;
    this.settleAt = now + this.settleSeconds * 1000;
    this.#schedule();
    return true;
  }

  #pointerDown(event) {
    if (event.target.closest?.('a, button, input, select, textarea')) return;
    const terminal = event.target.closest?.('.terminal-surface');
    const panel = event.target.closest?.('.panel');
    // A focused terminal is always live now, so it owns its own pointer input —
    // dragging inside it selects text instead of rotating the cube.
    if (terminal && Number(panel?.dataset.face) === this.focused) return;
    if (!this.dragInput({
      type: 'start',
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      panelFace: panel ? Number(panel.dataset.face) : null,
    })) return;
    this.viewport.setPointerCapture(event.pointerId);
  }

  #pointerMove(event) {
    if (!this.drag) {
      // movementX/Y is only populated for a mouse; touch would feed it undefined.
      if (this.zeroGravity && this.focused === null && event.pointerType === 'mouse') {
        this.#kick(event.movementX, event.movementY, 0.008);
      }
      return;
    }
    this.dragInput({ type: 'move', id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp });
  }

  #pointerUp(event) {
    this.dragInput({
      type: event.type === 'pointercancel' ? 'cancel' : 'end',
      id: event.pointerId,
      time: event.timeStamp,
    });
  }

  #wheel(event) {
    if (this.focused !== null) return;
    event.preventDefault();
    this.zoom = clamp(this.zoom - event.deltaY * 0.0012, MIN_ZOOM, MAX_ZOOM);
    this.#apply();
  }

  #kick(dx, dy, strength) {
    if (!this.zeroGravity || this.inertia || (!dx && !dy)) return;
    const now = Date.now();
    this.#advance(now);
    this.velocity.y += dx * strength;
    this.velocity.x -= dy * strength;
    const speed = Math.hypot(this.velocity.x, this.velocity.y);
    if (speed > MAX_ANGULAR_SPEED) {
      this.velocity.x *= MAX_ANGULAR_SPEED / speed;
      this.velocity.y *= MAX_ANGULAR_SPEED / speed;
    }
    this.settleAt = now + this.settleSeconds * 1000;
    this.#schedule();
  }

  #advance(now) {
    const end = Math.min(now, this.settleAt);
    const seconds = Math.max(0, end - this.lastTick) / 1000;
    const damping = (this.inertia ? DRAG_DAMPING : DAMPING) * SETTLE_SECONDS / (this.settleSeconds || SETTLE_SECONDS);
    if (seconds) {
      const x = integrateDamped(this.rotation.x, this.velocity.x, seconds, damping);
      const y = integrateDamped(this.rotation.y, this.velocity.y, seconds, damping);
      this.rotation = { x: x.position, y: y.position };
      this.velocity = { x: x.velocity, y: y.velocity };
    }
    this.lastTick = now;
    const stopSpeed = this.inertia ? DRAG_STOP_SPEED : STOP_SPEED;
    if (now >= this.settleAt || Math.hypot(this.velocity.x, this.velocity.y) <= stopSpeed) {
      this.velocity = { x: 0, y: 0 };
      this.inertia = false;
    }
  }

  #schedule() {
    if (this.frame || this.drag || this.focused !== null || !this.zeroGravity || !this.windowActive || !Math.hypot(this.velocity.x, this.velocity.y)) return;
    this.rig.classList.add('is-moving');
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.windowActive || document.hidden) return;
      this.#advance(Date.now());
      this.#apply();
      this.#schedule();
    });
  }

  #pause() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.rig.classList.remove('is-moving');
  }

  #setWindowActive(active) {
    this.windowActive = active;
    if (active) {
      this.#schedule();
      return;
    }
    if (this.drag) {
      const ids = [this.drag.id, this.drag.second?.id].filter((id) => id !== undefined);
      for (const id of ids) {
        if (typeof id === 'number' && this.viewport.hasPointerCapture(id)) this.viewport.releasePointerCapture(id);
        this.dragInput({ type: 'cancel', id });
      }
    }
    this.#pause();
  }

  #markPanels() {
    this.rig.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('is-focused', Number(panel.dataset.face) === this.focused);
    });
  }

  #apply(animated = false) {
    this.rig.style.transition = animated ? 'transform 420ms cubic-bezier(.2,.9,.2,1), filter 160ms ease' : 'filter 160ms ease';
    this.rig.style.setProperty('--rx', `${this.rotation.x}deg`);
    this.rig.style.setProperty('--ry', `${this.rotation.y}deg`);
    this.rig.style.setProperty('--scale', String(this.zoom));
    this.onMove(this.rotation);
    if (!this.frame && !this.drag && !Math.hypot(this.velocity.x, this.velocity.y)) this.rig.classList.remove('is-moving');
  }
}

function inputPair(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    span: Math.hypot(a.x - b.x, a.y - b.y),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
