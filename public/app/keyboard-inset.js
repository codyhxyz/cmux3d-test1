// A soft keyboard takes roughly a third of the screen. Collapsing browser chrome
// takes far less, and mistaking one for the other resized the cube mid-scroll.
const KEYBOARD_MIN_FRACTION = 0.2;
const KEYBOARD_MIN_PX = 120;

// The soft keyboard does not resize the layout viewport, so fixed chrome would sit
// underneath it. visualViewport is the only thing that reports the real space left.
export function trackKeyboardInset({ onChange = () => {} } = {}) {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  let frame = 0;
  const measure = () => {
    frame = 0;
    const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    const root = document.documentElement;
    root.style.setProperty('--kb-inset', `${Math.round(inset)}px`);

    // Only a keyboard is this big, and only a focused field can have raised one.
    const threshold = Math.max(KEYBOARD_MIN_PX, window.innerHeight * KEYBOARD_MIN_FRACTION);
    const editing = document.activeElement?.matches?.('textarea, input, [contenteditable]');
    const open = inset > threshold && Boolean(editing);
    document.body.classList.toggle('is-keyboard', open);
    // Read by the keyboard-only layout, so it must not move the cube when there
    // is no keyboard — otherwise chrome collapsing would resize it.
    if (open) root.style.setProperty('--vvh', `${Math.round(viewport.height)}px`);
    else root.style.removeProperty('--vvh');
    // iOS scrolls the whole page to reveal the focused field; undo it so the
    // fixed cube and key row stay where they belong.
    if (open && window.scrollY !== 0) window.scrollTo(0, 0);
    onChange(inset);
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };

  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  measure();

  return () => {
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
