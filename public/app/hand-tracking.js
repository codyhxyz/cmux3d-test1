const PALM_LANDMARKS = [0, 5, 9, 13, 17];
const OPEN_FINGERS = [[9, 10, 12], [13, 14, 16], [17, 18, 20]];
const MIN_HAND_SIZE = 0.08;
const MIN_OPEN_PINCH = 0.24;
const ARM_MS = 120;
const GRAB_MS = 80;
const RELEASE_MS = 50;
const LOST_GRACE_MS = 200;
const DEAD_ZONE = 0.0015;
const MAX_FRAME_DELTA = 0.06;
const VIRTUAL_SPAN = 650;

const STATUS = {
  searching: 'Looking for hand',
  blocked: 'Show an open hand',
  ineligible: 'Keep other fingers open',
  ready: 'Ready — pinch to grab',
  pinching: 'Pinching…',
  grabbed: 'Grabbed',
  reacquiring: 'Reacquiring…',
};
const STATUS_PRIORITY = ['grabbed', 'pinching', 'reacquiring', 'ready', 'ineligible', 'blocked', 'searching'];

export function handSample(result) {
  const landmarks = result?.landmarks;
  if (!landmarks || landmarks.length < 21 || landmarks.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) return null;

  const xs = landmarks.map(({ x }) => x);
  const ys = landmarks.map(({ y }) => y);
  const handSize = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (handSize < MIN_HAND_SIZE) return null;

  const palm = average(PALM_LANDMARKS.map((index) => landmarks[index]));
  const extended = OPEN_FINGERS.filter(([base, joint, tip]) => jointCosine(landmarks[base], landmarks[joint], landmarks[tip]) < -0.8).length;
  return {
    x: clamp(1 - palm.x, 0, 1),
    y: clamp(palm.y, 0, 1),
    pinch: distance2d(landmarks[4], landmarks[8]) / handSize,
    eligible: extended >= 2,
  };
}

export class HandController {
  constructor({ id = 'hand', onAction = () => {}, onFeedback = () => {}, sensitivity = 1 } = {}) {
    this.id = id;
    this.onAction = onAction;
    this.onFeedback = onFeedback;
    this.sensitivity = clamp(Number(sensitivity), 0.5, 2);
    this.xFilter = new OneEuroFilter();
    this.yFilter = new OneEuroFilter();
    this.virtual = { x: 0, y: 0 };
    this.reset(0, false);
  }

  setSensitivity(value) {
    this.sensitivity = clamp(Number(value), 0.5, 2);
  }

  update(result, time) {
    const sample = handSample(result);
    if (!sample) return this.#missing(time);

    const recovering = this.lostSince !== null;
    this.lastSeen = time;
    this.lostSince = null;

    if (recovering || !this.lastPoint) {
      this.xFilter.reset(sample.x, time);
      this.yFilter.reset(sample.y, time);
    }

    const point = {
      x: this.xFilter.filter(sample.x, time),
      y: this.yFilter.filter(sample.y, time),
    };
    const previous = recovering ? null : this.lastPoint;
    this.lastPoint = point;
    if (!this.dragging) this.virtual = { x: point.x * VIRTUAL_SPAN, y: point.y * VIRTUAL_SPAN };

    if (this.needsOpen) {
      if (sample.eligible && sample.pinch >= MIN_OPEN_PINCH) {
        this.openSince ??= time;
        this.openSamples.push(sample.pinch);
        if (time - this.openSince >= ARM_MS) {
          this.baseline = median(this.openSamples);
          this.needsOpen = false;
          this.openSince = null;
          this.openSamples = [];
          return this.#feedback('ready', sample, point);
        }
      } else {
        this.openSince = null;
        this.openSamples = [];
      }
      return this.#feedback('blocked', sample, point);
    }

    if (!this.dragging) {
      if (sample.eligible && sample.pinch <= this.#grabThreshold()) {
        this.pinchSince ??= time;
        if (time - this.pinchSince >= GRAB_MS) {
          this.pinchSince = null;
          const accepted = this.onAction({ type: 'start', id: this.id, ...this.virtual, time });
          if (accepted !== false) {
            this.dragging = true;
            return this.#feedback('grabbed', sample, point);
          }
          this.#requireOpen();
          return this.#feedback('blocked', sample, point);
        }
        return this.#feedback('pinching', sample, point);
      }

      this.pinchSince = null;
      if (sample.eligible && sample.pinch >= this.#releaseThreshold()) this.baseline = this.baseline * 0.95 + sample.pinch * 0.05;
      return this.#feedback(sample.pinch <= this.#grabThreshold() ? 'ineligible' : 'ready', sample, point);
    }

    if (previous && !this.#move(point.x - previous.x, point.y - previous.y, time)) {
      this.dragging = false;
      this.#requireOpen();
      return this.#feedback('blocked', sample, point);
    }

    if (sample.pinch >= this.#releaseThreshold()) {
      this.releaseSince ??= time;
      if (time - this.releaseSince >= RELEASE_MS) {
        this.onAction({ type: 'end', id: this.id, time });
        this.dragging = false;
        this.releaseSince = null;
        this.baseline = this.baseline * 0.95 + sample.pinch * 0.05;
        return this.#feedback('ready', sample, point);
      }
    } else {
      this.releaseSince = null;
    }

    return this.#feedback('grabbed', sample, point);
  }

  reset(time, cancel = true) {
    if (cancel && this.dragging) this.onAction({ type: 'cancel', id: this.id, time });
    this.dragging = false;
    this.#requireOpen();
    this.baseline = null;
    this.pinchSince = null;
    this.releaseSince = null;
    this.lastSeen = null;
    this.lostSince = null;
    this.lastPoint = null;
    this.xFilter.reset();
    this.yFilter.reset();
    this.onFeedback({ id: this.id, state: 'searching', visible: false, dragging: false });
  }

  #requireOpen() {
    this.needsOpen = true;
    this.openSince = null;
    this.openSamples = [];
  }

  #grabThreshold() {
    return clamp(this.baseline * 0.4, 0.1, 0.18);
  }

  #releaseThreshold() {
    return clamp(this.baseline * 0.65, 0.2, 0.32);
  }

  #move(dx, dy, time) {
    const length = Math.hypot(dx, dy);
    if (length <= DEAD_ZONE) return true;
    if (length > MAX_FRAME_DELTA) {
      dx *= MAX_FRAME_DELTA / length;
      dy *= MAX_FRAME_DELTA / length;
    }

    this.virtual.x += dx * VIRTUAL_SPAN * this.sensitivity;
    this.virtual.y += dy * VIRTUAL_SPAN * this.sensitivity;
    return this.onAction({ type: 'move', id: this.id, ...this.virtual, time }) !== false;
  }

  #missing(time) {
    if (this.lastSeen === null) {
      this.onFeedback({ id: this.id, state: 'searching', visible: false, dragging: false });
      return;
    }

    this.lostSince ??= time;
    if (time - this.lostSince <= LOST_GRACE_MS) {
      this.#feedback('reacquiring', null, this.lastPoint);
      return;
    }

    return this.reset(time);
  }

  #feedback(state, sample, point) {
    this.onFeedback({
      id: this.id,
      state,
      visible: Boolean(point),
      dragging: this.dragging,
      x: point?.x,
      y: point?.y,
      pinch: sample?.pinch,
      threshold: this.baseline && this.#grabThreshold(),
    });
  }
}

export function createHandTracking({ video, onInput, onStatus = () => {}, onFeedback = () => {} }) {
  let enabled = false;
  let stream = null;
  let worker = null;
  let workerReady = null;
  let resolveWorker = null;
  let rejectWorker = null;
  let workerBusy = false;
  let frame = 0;
  let frameKind = '';
  let generation = 0;
  let lastVideoTime = -1;
  let lastState = '';
  let running = false;

  const feedbackById = new Map();
  const controllers = new Map(['left', 'right'].map((handedness) => {
    const id = `hand-${handedness}`;
    return [handedness, new HandController({
      id,
      onAction: onInput,
      onFeedback(feedback) {
        feedbackById.set(id, feedback);
        onFeedback(feedback);
      },
    })];
  }));

  document.addEventListener('visibilitychange', handleActivity);
  window.addEventListener('focus', handleActivity);
  window.addEventListener('blur', handleActivity);

  async function enable(deviceId) {
    if (enabled) return true;
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.Worker || !globalThis.createImageBitmap) {
      onStatus('Hand control is not supported by this browser', false);
      return false;
    }

    enabled = true;
    generation += 1;
    lastState = '';
    running = null;
    onStatus('Starting…', true);

    try {
      await openCamera(deviceId);
      await ensureWorker();
      if (!enabled) return false;
      handleActivity();
      return true;
    } catch (error) {
      console.warn('[cmux3d] hand tracking unavailable:', error);
      disable(error?.message || String(error));
      return false;
    }
  }

  function disable(status = 'Off') {
    stopTracking();
    onStatus(status, false);
  }

  function selectCamera(deviceId) {
    if (!enabled) return true;
    stopTracking();
    return enable(deviceId);
  }

  function stopTracking() {
    enabled = false;
    generation += 1;
    running = false;
    stopLoop();
    resetControllers(performance.now());
    closeCamera();
  }

  function setSensitivity(value) {
    for (const controller of controllers.values()) controller.setSensitivity(value);
  }

  function resetControllers(time) {
    for (const controller of controllers.values()) controller.reset(time);
  }

  function updateStatus() {
    const states = new Set([...feedbackById.values()].map(({ state }) => state));
    const state = STATUS_PRIORITY.find((candidate) => states.has(candidate)) || 'searching';
    if (!enabled || state === lastState) return;
    lastState = state;
    onStatus(STATUS[state], true);
  }

  async function openCamera(deviceId) {
    closeCamera();
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    lastVideoTime = -1;
    for (const track of stream.getVideoTracks()) {
      track.onended = () => {
        if (enabled) disable('Camera disconnected');
      };
    }
  }

  function closeCamera() {
    for (const track of stream?.getTracks() || []) {
      track.onended = null;
      track.stop();
    }
    stream = null;
    video.srcObject = null;
  }

  async function cameras() {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    return (devices || []).filter((device) => device.kind === 'videoinput');
  }

  function ensureWorker() {
    if (workerReady) return workerReady;

    worker = new Worker('/app/hand-worker.js', { type: 'module' });
    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', (event) => failWorker(event.error || new Error(event.message || 'Hand tracking worker failed')));
    workerReady = new Promise((resolve, reject) => {
      resolveWorker = resolve;
      rejectWorker = reject;
    });
    return workerReady;
  }

  function handleWorkerMessage({ data }) {
    if (data.type === 'ready') {
      resolveWorker?.();
      resolveWorker = null;
      rejectWorker = null;
      return;
    }

    if (data.type === 'error') {
      failWorker(new Error(data.message));
      return;
    }

    if (data.type !== 'result') return;
    workerBusy = false;
    if (!enabled || !running || data.generation !== generation) return;

    const detected = new Map((data.handedness || []).map((categories, index) => [
      categories[0]?.categoryName?.toLowerCase(),
      data.landmarks?.[index],
    ]));
    for (const [handedness, controller] of controllers) {
      const landmarks = detected.get(handedness);
      controller.update(landmarks ? { landmarks } : null, data.timestamp);
    }
    updateStatus();
  }

  function failWorker(error) {
    const wasStarting = Boolean(rejectWorker);
    rejectWorker?.(error);
    resolveWorker = null;
    rejectWorker = null;
    worker?.terminate();
    worker = null;
    workerReady = null;
    workerBusy = false;
    if (!wasStarting && enabled) disable(error.message);
  }

  function handleActivity() {
    if (!enabled) return;
    const active = !document.hidden && document.hasFocus();
    if (running === active) return;
    running = active;
    stream?.getTracks().forEach((track) => { track.enabled = active; });
    resetControllers(performance.now());
    if (active) {
      onStatus('Looking for hand', true);
      schedule();
    } else {
      stopLoop();
      onStatus('Paused', true);
    }
  }

  function schedule() {
    if (frame || !enabled || !running) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameKind = 'video';
      frame = video.requestVideoFrameCallback(processFrame);
    } else {
      frameKind = 'animation';
      frame = requestAnimationFrame(processFrame);
    }
  }

  function stopLoop() {
    if (!frame) return;
    if (frameKind === 'video') video.cancelVideoFrameCallback(frame);
    else cancelAnimationFrame(frame);
    frame = 0;
  }

  function processFrame(timestamp) {
    frame = 0;
    if (!enabled || !running || !worker || !video.srcObject) return;

    if (!workerBusy && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      workerBusy = true;
      const currentGeneration = generation;
      createImageBitmap(video).then((bitmap) => {
        if (!enabled || !running || !worker || currentGeneration !== generation) {
          bitmap.close();
          workerBusy = false;
          return;
        }
        worker.postMessage({ type: 'frame', frame: bitmap, timestamp, generation: currentGeneration }, [bitmap]);
      }).catch((error) => {
        workerBusy = false;
        console.warn('[cmux3d] camera frame unavailable:', error);
      });
    }
    schedule();
  }

  return {
    enable,
    disable,
    selectCamera,
    setSensitivity,
    cameras,
    cameraId: () => stream?.getVideoTracks()[0]?.getSettings().deviceId || '',
  };
}

class OneEuroFilter {
  constructor(minCutoff = 1.5, beta = 0.8, derivativeCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.reset();
  }

  reset(value, time) {
    this.raw = value;
    this.value = value;
    this.derivative = 0;
    this.time = time;
  }

  filter(value, time) {
    if (this.time === undefined) {
      this.reset(value, time);
      return value;
    }

    const seconds = Math.max((time - this.time) / 1000, 1 / 120);
    const derivative = lowPass((value - this.raw) / seconds, this.derivative, alpha(this.derivativeCutoff, seconds));
    const filtered = lowPass(value, this.value, alpha(this.minCutoff + this.beta * Math.abs(derivative), seconds));
    this.raw = value;
    this.value = filtered;
    this.derivative = derivative;
    this.time = time;
    return filtered;
  }
}

function alpha(cutoff, seconds) {
  return 1 / (1 + 1 / (2 * Math.PI * cutoff * seconds));
}

function lowPass(value, previous, amount) {
  return amount * value + (1 - amount) * previous;
}

function average(points) {
  const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function jointCosine(a, joint, b) {
  const ax = a.x - joint.x;
  const ay = a.y - joint.y;
  const bx = b.x - joint.x;
  const by = b.y - joint.y;
  return (ax * bx + ay * by) / Math.hypot(ax, ay) / Math.hypot(bx, by);
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
