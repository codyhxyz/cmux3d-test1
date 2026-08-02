const COMMAND_KEYS = {
  ArrowLeft: '\x01',
  ArrowRight: '\x05',
  Backspace: '\x15',
};

const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D' };

// Keys a soft keyboard cannot produce, for the on-screen accessory row.
export function accessoryKeyInput(key, { applicationCursorKeys = false } = {}) {
  if (key === 'escape') return '\x1b';
  if (key === 'tab') return '\t';
  const arrow = ARROWS[key];
  return arrow ? `\x1b${applicationCursorKeys ? 'O' : '['}${arrow}` : undefined;
}

export function ctrlCode(character) {
  const value = String(character || '');
  if (value.length !== 1) return undefined;
  const code = value.toUpperCase().charCodeAt(0);
  if (code === 32 || (code >= 64 && code <= 95)) return String.fromCharCode(code & 31);
  return undefined;
}

export function commandKeyInput(event) {
  if (!commandOnly(event)) return;
  return COMMAND_KEYS[event.key];
}

export function commandPromptDirection(event) {
  if (!commandOnly(event)) return 0;
  return event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
}

export function promptLine(lines, anchor, direction) {
  let target;
  for (const line of lines) {
    if (direction < 0 && line < anchor && (target === undefined || line > target)) target = line;
    if (direction > 0 && line > anchor && (target === undefined || line < target)) target = line;
  }
  return target;
}

function commandOnly(event) {
  return event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
}
