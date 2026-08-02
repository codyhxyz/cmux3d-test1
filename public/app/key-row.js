export function createKeyRow({ element, onKey, onPaste, onCtrl, onRelease }) {
  if (!element) return { show() {}, hide() {}, setCtrl() {} };

  const ctrlButton = element.querySelector('[data-key="ctrl"]');
  const pasteButton = element.querySelector('[data-key="paste"]');

  // Taking focus would dismiss the soft keyboard the moment a key is tapped.
  element.addEventListener('pointerdown', (event) => event.preventDefault());

  element.addEventListener('click', (event) => {
    const key = event.target.closest('[data-key]')?.dataset.key;
    if (!key) return;
    if (key === 'ctrl') onCtrl(ctrlButton.getAttribute('aria-pressed') !== 'true');
    else if (key === 'paste') onPaste();
    else if (key === 'release') onRelease();
    else onKey(key);
  });

  return {
    show() {
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
      ctrlButton?.setAttribute('aria-pressed', 'false');
    },
    setCtrl(armed) {
      ctrlButton?.setAttribute('aria-pressed', String(armed));
    },
    reportPaste(ok) {
      if (!pasteButton || ok) return;
      pasteButton.textContent = 'no access';
      setTimeout(() => { pasteButton.textContent = 'paste'; }, 1500);
    },
  };
}
