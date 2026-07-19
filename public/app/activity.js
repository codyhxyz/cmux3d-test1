const listeners = new Set();

export const isPageActive = () => !document.hidden && document.hasFocus();

export function onPageActivity(listener) {
  listeners.add(listener);
  listener(isPageActive());
  if (listeners.size > 1) return;
  const notify = () => {
    const active = isPageActive();
    for (const callback of listeners) callback(active);
  };
  for (const event of ['focus', 'blur', 'pageshow', 'pagehide']) window.addEventListener(event, notify);
  document.addEventListener('visibilitychange', notify);
}
