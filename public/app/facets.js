// The cube is a prism: N-2 side panels evenly spaced around the vertical axis, plus a
// Crown and a Keel cap. At six faces that is a square prism, which is the cube the
// product shipped with, down to the names, codes and orbit angles below.

const terminalTheme = {
  background: 'transparent',
  foreground: '#e7edf5',
  cursor: '#64c7e8',
};

export const MIN_FACES = 6;
// Measured, not assumed. AgentCore serves ten concurrent interactive shells per runtime
// SESSION — spike/RESULTS.md T-10, where twelve shells across two sessions on one
// runtime is what disproved the docs' "per runtime" reading. One workspace is one
// session, so one workspace can never render more than ten faces. This constant is that
// limit and nothing else; do not raise it without re-measuring.
export const MAX_FACES = 10;
export const DEFAULT_FACES = 6;

// Crown and Keel hold face indices 4 and 5 at every count, so widening the prism never
// renames a face or moves an agent onto a different panel — the sides that appear take
// the unused indices at the end. Face index f is always shell `face-${f + 1}`.
const CAPS = [
  { face: 4, name: 'Crown', code: 'C-04', view: { x: -96, y: 0 }, angle: 90 },
  { face: 5, name: 'Keel', code: 'K-05', view: { x: 82, y: 0 }, angle: -90 },
];

// The sides in the order they sit around the drum, clockwise from the bow. With four
// sides the ring step is 90deg and this list reproduces the shipped cube exactly:
// Fore 0deg, Starboard 90deg, Aft 180deg, Port -90deg. Beyond four the metaphor stops
// being a compass, so the extra sides are named for parts of a hull instead.
const SIDES = [
  { face: 0, name: 'Fore', code: 'F-00' },
  { face: 2, name: 'Starboard', code: 'S-02' },
  { face: 1, name: 'Aft', code: 'A-01' },
  { face: 3, name: 'Port', code: 'P-03' },
  { face: 6, name: 'Beam', code: 'B-06' },
  { face: 7, name: 'Quarter', code: 'Q-07' },
  { face: 8, name: 'Waist', code: 'W-08' },
  { face: 9, name: 'Transom', code: 'T-09' },
];

// Out of range is clamped, never fatal: this value reaches us from a slider, from
// localStorage and from the gateway, and any of them can be stale or hand-edited.
export function clampFaces(value, fallback = DEFAULT_FACES) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_FACES, Math.max(MIN_FACES, number));
}

export function buildFacets(count = DEFAULT_FACES) {
  const faces = clampFaces(count);
  const sides = faces - CAPS.length;
  const step = 360 / sides;
  return [
    ...SIDES.slice(0, sides).map((side, ring) => {
      const angle = normalizeAngle(ring * step);
      // Looking at a panel rotated by angle means turning the rig back by the same
      // amount, which is how Starboard at 90deg has always been viewed from -90deg.
      return { ...side, theme: terminalTheme, cap: false, angle, view: { x: -8, y: normalizeAngle(-angle) } };
    }),
    ...CAPS.map((cap) => ({ ...cap, theme: terminalTheme, cap: true })),
  ].sort((a, b) => a.face - b.face);
}

// Panels keep one constant width, so each extra side buys a wider drum — 1.85x across
// at ten faces, which would leave the frame on a phone. This scales the whole prism
// back to the square prism's circumradius. It is exactly 1 at four sides, so six faces
// are scaled by an identity matrix and nothing moves.
export function drumScale(count = DEFAULT_FACES) {
  const sides = clampFaces(count) - CAPS.length;
  return Math.sin(Math.PI / sides) / Math.sin(Math.PI / 4);
}

// The caps are square panels closing an N-gon, which is exactly right for a square
// prism and wrong for every wider one. A square whose corners sit on the drum's
// circumcircle puts those corners in the middle of a FLAT, not on a vertex, so they
// hang outside the silhouette — measured 10.1% past the drum at seven faces, 11.5% at
// eight, 8.2% at ten — and the lid reads as a kite stuck through the drum. Past four
// sides the cap is therefore grown to the drum's circumdiameter and clipped to the
// same polygon the sides describe, so it ends exactly where the drum does.
//
// Four sides is left completely alone: there the square IS the polygon, and clipping
// it would shave off the border and the 8px radius that make the cube's top face what
// it is. Every value below is null at six faces so nothing is applied at all.
export function capSize(count) {
  const sides = sideCount(count);
  // Circumdiameter = W / sin(180/S), and drumScale() is sin(180/S) / sin(45).
  return sides === 4 ? null : `calc(var(--cube) * ${round(Math.SQRT2 / drumScale(count))})`;
}

// Content has to live inside the polygon, not inside its bounding box, or the header
// bar sits in a clipped-away corner and the face loses its name.
export function capPadding(count) {
  const sides = sideCount(count);
  if (sides === 4) return null;
  // Largest centred axis-aligned square inside the polygon: for every edge normal the
  // square's support s * (|cos| + |sin|) must stay within the apothem.
  const apothem = Math.cos(Math.PI / sides);
  const step = (2 * Math.PI) / sides;
  const half = Math.min(...Array.from({ length: sides }, (_, edge) => {
    const angle = edge * step;
    return apothem / (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)));
  }));
  // The element is 2 units across for a circumradius of 1, so this is a fraction of it.
  return `${round(50 * (1 - half))}%`;
}

// The drum's cross-section, drawn in the cap's own coordinates.
export function capClipPath(count, angle) {
  const sides = sideCount(count);
  if (sides === 4) return null;
  // rotateX(90deg) maps the panel's local y onto world +z and rotateX(-90deg) onto
  // world -z, so the two caps see the same drum mirrored. Getting this wrong is
  // invisible at an even side count and visibly twists the lid at an odd one.
  const flip = angle < 0 ? -1 : 1;
  const step = (2 * Math.PI) / sides;
  const points = Array.from({ length: sides }, (_, vertex) => {
    // Vertices sit halfway between neighbouring side normals, at the circumradius —
    // which is half the element, now that the element is the circumdiameter.
    const phi = vertex * step + step / 2;
    return `${round(50 + 50 * Math.sin(phi))}% ${round(50 + flip * 50 * Math.cos(phi))}%`;
  });
  return `polygon(${points.join(', ')})`;
}

function sideCount(count) {
  return clampFaces(count) - CAPS.length;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

// Into (-180, 180], so a four-sided ring emits the literal 180deg and -90deg the cube
// has always used rather than the equivalent 180deg and 270deg.
function normalizeAngle(degrees) {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

// terminals.js and space.js import this binding directly. It is reassigned rather than
// mutated in place so every importer moves to the new list at the same instant through
// the ES module live binding.
export let FACETS = buildFacets(DEFAULT_FACES);

export function setFaceCount(count) {
  FACETS = buildFacets(count);
  return FACETS;
}
