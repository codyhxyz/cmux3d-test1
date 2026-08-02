const KEYBOARD_THRESHOLD = 80;

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
    root.style.setProperty('--vvh', `${Math.round(viewport.height)}px`);
    const open = inset > KEYBOARD_THRESHOLD;
    document.body.classList.toggle('is-keyboard', open);
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
