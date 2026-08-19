// Package originauth is the Go port of src/server/origin.js.
//
// Every rule here is load-bearing for the cube's security posture; the comments explaining
// why are carried over from the JS deliberately, because the reasoning is the spec.
package originauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/codyhxyz/coding-cube/go/internal/connection"
)

// Exposure is the tailnet reachability filled in after listen(), read per request.
type Exposure struct {
	Active   bool
	TSOrigin string
}

// Identity resolves a tailnet peer to a login. Implemented by internal/tailscale.
type Identity interface {
	IdentifyHeaders(header http.Header) bool
	Identify(remoteAddr string) bool
}

type Options struct {
	WebOrigin string
	Token     string
	Exposure  *Exposure
	Tailnet   Identity
}

// RequestIsRemote reports whether a request crossed the tailnet.
//
// `tailscale serve` proxies from loopback, so the forwarded header is the only signal
// that a request crossed the tailnet. Browsers cannot forge it: it is not CORS-safelisted,
// so setting it forces a preflight the origin allowlist rejects.
func RequestIsRemote(req *http.Request) bool {
	if _, ok := req.Header["X-Forwarded-For"]; ok {
		return true
	}
	return !connection.IsLoopbackAddress(remoteIP(req))
}

type OriginOptions struct {
	WebOrigin   string
	Exposure    *Exposure
	RequestHost string
	Remote      bool
}

func BrowserOriginAllowed(origin string, opts OriginOptions) bool {
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	if connection.IsLoopbackHostname(parsed.Hostname()) {
		return true
	}
	if opts.WebOrigin != "" && origin == opts.WebOrigin {
		return true
	}
	if opts.Exposure != nil && opts.Exposure.TSOrigin != "" && origin == opts.Exposure.TSOrigin {
		return true
	}
	// The Host header is attacker-controlled, so it may only widen access for requests
	// that already have to present a pairing code. Trusting it on a loopback socket would
	// let any site reach the shells by rebinding its DNS.
	return opts.Remote && opts.RequestHost != "" && parsed.Host == opts.RequestHost
}

func RequestAuthorized(req *http.Request, requestURL *url.URL, opts Options) bool {
	if opts.Token == "" {
		return true
	}

	origin := req.Header.Get("Origin")
	// Local tools and the locally served page share the shell's trust domain already.
	if !RequestIsRemote(req) && (origin == "" || connection.IsLoopbackOrigin(origin)) && origin != opts.WebOrigin {
		return true
	}
	if TokensMatch(requestURL.Query().Get("token"), opts.Token) {
		return true
	}

	// Tailscale Serve strips spoofed identity headers and adds the authenticated user's
	// login before proxying to our loopback-only cloud gateway.
	if opts.Tailnet == nil {
		return false
	}
	if connection.IsLoopbackAddress(remoteIP(req)) && opts.Tailnet.IdentifyHeaders(req.Header) {
		return true
	}

	// Direct tailnet access uses tailscaled's whois result for the real peer IP. Hosted
	// cross-origin requests must use Serve so identity headers are present.
	if origin == opts.WebOrigin {
		return false
	}
	return opts.Tailnet.Identify(remoteIP(req))
}

// TrustedForSecrets gates the pairing code itself. It is the one credential that unlocks
// this host from anywhere, so it is never handed to a cross-origin page that has not
// already presented it.
func TrustedForSecrets(req *http.Request, requestURL *url.URL, token string) bool {
	if req.Header.Get("Origin") != "" {
		return TokensMatch(requestURL.Query().Get("token"), token)
	}
	return !RequestIsRemote(req)
}

// AllowCORS mirrors the JS: it reports whether the origin was allowed and sets the
// response headers when it was. A request with no Origin is same-origin and needs none.
func AllowCORS(req *http.Request, header http.Header, webOrigin string, exposure *Exposure) bool {
	origin := req.Header.Get("Origin")
	allowed := BrowserOriginAllowed(origin, OriginOptions{
		WebOrigin:   webOrigin,
		Exposure:    exposure,
		RequestHost: req.Host,
		Remote:      RequestIsRemote(req),
	})
	if origin == "" || !allowed {
		return false
	}
	header.Set("Access-Control-Allow-Origin", origin)
	header.Set("Access-Control-Allow-Private-Network", "true")
	header.Set("Vary", "Origin")
	return true
}

// TokensMatch compares in constant time. Both sides are hashed first so the comparison
// runs over equal-length inputs and cannot leak the token's length.
func TokensMatch(candidate, token string) bool {
	if candidate == "" {
		return false
	}
	a := sha256.Sum256([]byte(candidate))
	b := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// remoteIP strips the port net/http appends, and the ::ffff: prefix a v4-mapped v6
// socket reports, so the result is comparable to the loopback literals.
//
// net/http brackets IPv6 ("[::1]:51000"), but a proxy or a hand-built request can present
// the bare form ("::ffff:127.0.0.1:51000") that SplitHostPort refuses. Falling back to
// trimming the last colon group keeps a v4-mapped loopback address readable as loopback
// rather than silently classifying this machine as remote.
func remoteIP(req *http.Request) string {
	addr := req.RemoteAddr
	if addr == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return strings.TrimPrefix(host, "::ffff:")
	}
	if net.ParseIP(addr) == nil {
		if index := strings.LastIndex(addr, ":"); index > 0 {
			if trimmed := addr[:index]; net.ParseIP(trimmed) != nil {
				addr = trimmed
			}
		}
	}
	return strings.TrimPrefix(addr, "::ffff:")
}
