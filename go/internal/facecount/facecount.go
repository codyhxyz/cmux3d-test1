// Package facecount mirrors public/app/face-count.js.
//
// One workspace is one AgentCore runtime session. The service was measured serving ten
// concurrent shells per session (spike/RESULTS.md T-10), so every layer that provisions,
// serves or renders faces shares this contract. The browser copy stays authoritative for
// the page; this copy exists so the gateway agrees with it without shipping a JS runtime.
package facecount

const (
	Default = 6
	Min     = 6
	Max     = 10
)

// Clamp reports the usable count alongside what was asked for. Out-of-range input is
// clamped and reported, never fatal: counts arrive from browser storage, controls and
// query strings, any of which may be stale or hand-edited.
type Clamped struct {
	Faces     int
	Requested int
	HasValue  bool
	Clamped   bool
}

func Clamp(value int, hasValue bool, fallback int) Clamped {
	if !hasValue {
		return Clamped{Faces: fallback}
	}
	faces := min(Max, max(Min, value))
	return Clamped{Faces: faces, Requested: value, HasValue: true, Clamped: faces != value}
}

// ClampDefault is Clamp with the canonical fallback, for the common case.
func ClampDefault(value int) Clamped { return Clamp(value, true, Default) }
