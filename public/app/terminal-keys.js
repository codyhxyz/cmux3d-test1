const COMMAND_KEYS = {
  ArrowLeft: '\x01',
  ArrowRight: '\x05',
  Backspace: '\x15',
};

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
