// The same encoder the browser vendors — public/app/qr.js draws its output as an SVG path,
// this draws it in a terminal. Only the paper changes.
//
// A terminal cell is about twice as tall as it is wide, so one cell carries two module rows:
// `▀` paints the upper module in the foreground colour and the lower one in the background.
// A 37-module symbol lands in 41 columns and 21 rows, which fits an unresized window.

import qrcode from 'qrcode-generator';

// Two modules of quiet zone rather than the specified four. Four doubles the height for
// margin a camera pointed at a screen does not need, and the terminal's own padding is
// already there. Measured against iOS and Android cameras at arm's length.
const QUIET = 2;

/** The symbol as rows of booleans, quiet zone included. @returns {boolean[][]} */
export function qrModules(text, { quiet = QUIET, level = 'M' } = {}) {
  const code = qrcode(0, level); // version 0 = pick the smallest that fits
  code.addData(text);
  code.make();

  const size = code.getModuleCount();
  const span = size + quiet * 2;
  return Array.from({ length: span }, (_, row) => Array.from({ length: span }, (_, column) => {
    const symbolRow = row - quiet;
    const symbolColumn = column - quiet;
    return symbolRow >= 0 && symbolColumn >= 0 && symbolRow < size && symbolColumn < size
      && code.isDark(symbolRow, symbolColumn);
  }));
}

// Truecolor rather than the terminal's palette: a scanner needs real black on real white,
// and "white" in a themed palette is whatever the theme decided. NO_COLOR is deliberately
// not honoured — an uncoloured QR is an unreadable QR, and the printed link underneath is
// the fallback for anything that cannot draw this.
export function qrBlock(text, options) {
  const grid = qrModules(text, options);
  const lines = [];

  for (let row = 0; row < grid.length; row += 2) {
    let line = '';
    let previous = '';
    for (let column = 0; column < grid.length; column += 1) {
      // A QR symbol is always an odd number of modules across and the quiet zone is even,
      // so the span is odd and the missing bottom half is always quiet zone.
      const colours = `\x1b[38;2;${ink(grid[row][column])};48;2;${ink(grid[row + 1]?.[column])}m`;
      if (colours !== previous) {
        line += colours;
        previous = colours;
      }
      line += '▀';
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join('\n');
}

function ink(dark) {
  return dark ? '0;0;0' : '255;255;255';
}
