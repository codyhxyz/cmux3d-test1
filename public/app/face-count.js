// One workspace is one AgentCore runtime session. The service was measured serving ten
// concurrent shells per session (spike/RESULTS.md T-10), so every layer that provisions,
// serves or renders faces shares this browser-safe contract.
export const DEFAULT_FACE_COUNT = 6;
export const MIN_FACE_COUNT = 6;
export const MAX_FACE_COUNT = 10;

// Out-of-range input is clamped and reported, never fatal. Counts arrive from browser
// storage, controls and query strings, any of which may be stale or hand-edited.
export function clampFaceCount(value, fallback = DEFAULT_FACE_COUNT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return { faces: fallback, requested: null, clamped: false };
  const requested = Math.trunc(number);
  const faces = Math.min(MAX_FACE_COUNT, Math.max(MIN_FACE_COUNT, requested));
  return { faces, requested, clamped: faces !== requested };
}
