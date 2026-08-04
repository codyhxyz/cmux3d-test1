import qrcode from '/vendor/qrcode.mjs';

// Kazuhiko Arase's qrcode-generator does the encoding; this only turns its module
// grid into an SVG path, so the page needs no canvas and no network fetch.
export function qrSvg(text, { quiet = 4, level = 'M' } = {}) {
  const code = qrcode(0, level); // version 0 = pick the smallest that fits
  code.addData(text);
  code.make();

  const size = code.getModuleCount();
  const span = size + quiet * 2;
  let path = '';
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (code.isDark(row, column)) path += `M${column + quiet} ${row + quiet}h1v1h-1z`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img">`
    + `<rect width="${span}" height="${span}" fill="#ffffff"/>`
    + `<path d="${path}" fill="#000000"/></svg>`;
}

export function qrModules(text, { level = 'M' } = {}) {
  const code = qrcode(0, level);
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  return {
    size,
    modules: Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => (code.isDark(row, column) ? 1 : 0))),
  };
}
