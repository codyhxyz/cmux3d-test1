const wasm = ['internal', 'module_internal', 'nosimd_internal']
  .flatMap((variant) => ['js', 'wasm'].map((extension) => `vision_wasm_${variant}.${extension}`));

export const VENDOR_ASSETS = [
  ['/vendor/xterm.css', '@xterm/xterm/css/xterm.css'],
  ['/vendor/xterm.mjs', '@xterm/xterm/lib/xterm.mjs'],
  ['/vendor/addon-attach.mjs', '@xterm/addon-attach/lib/addon-attach.mjs'],
  ['/vendor/addon-fit.mjs', '@xterm/addon-fit/lib/addon-fit.mjs'],
  ['/vendor/addon-webgl.mjs', '@xterm/addon-webgl/lib/addon-webgl.mjs'],
  ['/vendor/qrcode.mjs', 'qrcode-generator/dist/qrcode.mjs'],
  ['/vendor/mediapipe/vision_bundle.mjs', '@mediapipe/tasks-vision/vision_bundle.mjs'],
  ...wasm.map((file) => [`/vendor/mediapipe/wasm/${file}`, `@mediapipe/tasks-vision/wasm/${file}`]),
];
