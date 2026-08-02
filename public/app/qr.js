// Minimal QR encoder (byte mode, error correction level M, versions 1-10).
// Enough for pairing links; no dependency and no network fetch.

const EC_CODEWORDS = [null, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const EC_BLOCKS = [null, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const TOTAL_CODEWORDS = [null, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const FORMAT_M = 0b00; // error correction level M

export function encodeQr(text) {
  const data = new TextEncoder().encode(text);
  const version = pickVersion(data.length);
  if (!version) throw new Error('payload too long for this QR encoder');

  const codewords = addErrorCorrection(buildDataCodewords(data, version), version);
  const size = version * 4 + 17;
  const modules = drawSymbol(codewords, version, size);
  return { size, modules };
}

export function qrSvg(text, { quiet = 4 } = {}) {
  const { size, modules } = encodeQr(text);
  const span = size + quiet * 2;
  let path = '';
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img">`
    + `<rect width="${span}" height="${span}" fill="#ffffff"/>`
    + `<path d="${path}" fill="#000000"/></svg>`;
}

function pickVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    const blocks = EC_BLOCKS[version];
    const capacity = TOTAL_CODEWORDS[version] - EC_CODEWORDS[version] * blocks;
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (byteLength * 8 + headerBits <= capacity * 8) return version;
  }
  return null;
}

function buildDataCodewords(data, version) {
  const blocks = EC_BLOCKS[version];
  const capacity = TOTAL_CODEWORDS[version] - EC_CODEWORDS[version] * blocks;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(data.length, version < 10 ? 8 : 16);
  for (const byte of data) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let i = 0; codewords.length < capacity; i += 1) codewords.push(i % 2 ? 0x11 : 0xec);
  return codewords;
}

function addErrorCorrection(data, version) {
  const blockCount = EC_BLOCKS[version];
  const ecLength = EC_CODEWORDS[version];
  const shortLength = Math.floor(data.length / blockCount);
  const longBlocks = data.length % blockCount;

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const length = shortLength + (i >= blockCount - longBlocks ? 1 : 0);
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(reedSolomon(block, ecLength));
  }

  const result = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecLength; i += 1) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];

function reedSolomon(data, ecLength) {
  const generator = [1];
  for (let i = 0; i < ecLength; i += 1) {
    generator.push(0);
    for (let j = generator.length - 1; j > 0; j -= 1) {
      generator[j] ^= generator[j - 1] ? EXP[(LOG[generator[j - 1]] + i) % 255] : 0;
    }
  }

  const remainder = new Array(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    if (factor) {
      for (let i = 0; i < ecLength; i += 1) {
        remainder[i] ^= generator[i + 1] ? EXP[(LOG[generator[i + 1]] + LOG[factor]) % 255] : 0;
      }
    }
  }
  return remainder;
}

function drawSymbol(codewords, version, size) {
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserve = (x, y, value) => {
    if (x >= 0 && x < size && y >= 0 && y < size) modules[y][x] = value;
  };

  for (const [fx, fy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const edge = x === -1 || x === 7 || y === -1 || y === 7;
        const ring = x === 0 || x === 6 || y === 0 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        reserve(fx + x, fy + y, edge ? 0 : (ring || core) ? 1 : 0);
      }
    }
  }

  for (const cx of ALIGNMENT[version]) {
    for (const cy of ALIGNMENT[version]) {
      if (modules[cy][cx] !== null) continue;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          reserve(cx + x, cy + y, Math.max(Math.abs(x), Math.abs(y)) !== 1 ? 1 : 0);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    const value = i % 2 === 0 ? 1 : 0;
    if (modules[6][i] === null) modules[6][i] = value;
    if (modules[i][6] === null) modules[i][6] = value;
  }
  modules[size - 8][8] = 1; // dark module

  const formatCells = formatPositions(size);
  const versionCells = version >= 7 ? versionPositions(size) : [];

  const reserved = modules.map((row) => row.map((cell) => cell !== null));
  for (const [x, y] of formatCells) reserved[y][x] = true;
  for (const [x, y] of versionCells) reserved[y][x] = true;

  let bitIndex = 0;
  const bitAt = (index) => (index >> 3) < codewords.length && (codewords[index >> 3] >> (7 - (index & 7))) & 1;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const upward = ((size - 1 - right) >> 1) % 2 === 0;
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[y][x]) continue;
        const bit = bitAt(bitIndex);
        bitIndex += 1;
        // Mask 0: alternate on (row + column) parity.
        modules[y][x] = bit ^ ((x + y) % 2 === 0 ? 1 : 0);
      }
    }
  }

  applyFormatBits(modules, size, formatCells);
  if (version >= 7) applyVersionBits(modules, version, versionCells);
  return modules.map((row) => row.map((cell) => (cell === null ? 0 : cell)));
}

// Versions 7 and up carry an 18-bit version block beside the top-right and
// bottom-left finders; without it decoders reject the symbol outright.
function versionPositions(size) {
  const cells = [];
  for (let i = 0; i < 18; i += 1) cells.push([Math.floor(i / 3), size - 11 + (i % 3)]);
  for (let i = 0; i < 18; i += 1) cells.push([size - 11 + (i % 3), Math.floor(i / 3)]);
  return cells;
}

function applyVersionBits(modules, version, cells) {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >> 11) * 0x1f25);
  const bits = (version << 12) | remainder;

  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1;
    const [x, y] = cells[i];
    modules[y][x] = bit;
    const [mx, my] = cells[i + 18];
    modules[my][mx] = bit;
  }
}

function formatPositions(size) {
  const cells = [];
  for (let i = 0; i <= 5; i += 1) cells.push([8, i]);
  cells.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i <= 14; i += 1) cells.push([14 - i, 8]);
  for (let i = 0; i <= 7; i += 1) cells.push([size - 1 - i, 8]);
  for (let i = 8; i <= 14; i += 1) cells.push([8, size - 15 + i]);
  return cells;
}

function applyFormatBits(modules, size, cells) {
  const data = (FORMAT_M << 3) | 0; // level M, mask pattern 0
  let value = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((value >> (i + 10)) & 1) value ^= 0b10100110111 << i;
  }
  const format = ((data << 10) | value) ^ 0b101010000010010;

  for (let i = 0; i < 15; i += 1) {
    const bit = (format >> i) & 1;
    const [x, y] = cells[i];
    modules[y][x] = bit;
    const [mx, my] = cells[i + 15];
    modules[my][mx] = bit;
  }
}
