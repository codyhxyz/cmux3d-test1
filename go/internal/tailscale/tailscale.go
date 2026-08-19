// Package tailscale is the Go port of src/server/tailscale.js.
package tailscale

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var fallbackBinaries = []string{
	"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
	"/usr/bin/tailscale",
}

func Find() string {
	for _, candidate := range fallbackBinaries {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "tailscale"
}

type Status struct {
	Running     bool
	DNSName     string
	IP          string
	CertDomains []string
	MagicDNS    bool
}

type statusEnvelope struct {
	BackendState string `json:"BackendState"`
	Self         *struct {
		DNSName      string   `json:"DNSName"`
		TailscaleIPs []string `json:"TailscaleIPs"`
	} `json:"Self"`
	CertDomains    []string `json:"CertDomains"`
	CurrentTailnet *struct {
		MagicDNSEnabled *bool `json:"MagicDNSEnabled"`
	} `json:"CurrentTailnet"`
}

func ParseStatus(raw []byte) *Status {
	var envelope statusEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil
	}
	status := &Status{
		Running:     envelope.BackendState == "Running",
		CertDomains: envelope.CertDomains,
		MagicDNS:    envelope.CurrentTailnet == nil || envelope.CurrentTailnet.MagicDNSEnabled == nil || *envelope.CurrentTailnet.MagicDNSEnabled,
	}
	if envelope.Self != nil {
		status.DNSName = strings.TrimSuffix(envelope.Self.DNSName, ".")
		for _, address := range envelope.Self.TailscaleIPs {
			if strings.Contains(address, ".") {
				status.IP = address
				break
			}
		}
	}
	return status
}

type Address struct {
	IP      string
	DNSName string
}

// Addr binds straight to the tailnet address, which needs no certificate and no serve
// rule. It is the shortest path to real shells on a phone, so it runs before listen().
func Addr(ctx context.Context) *Address {
	status := ParseStatus(runJSON(ctx, Find(), []string{"status", "--json"}, 3*time.Second))
	if status == nil || !status.Running || status.IP == "" {
		return nil
	}
	return &Address{IP: status.IP, DNSName: status.DNSName}
}

type Profile struct {
	Node  string
	Login string
}

type whoisEnvelope struct {
	Node *struct {
		Name string `json:"Name"`
	} `json:"Node"`
	UserProfile *struct {
		LoginName string `json:"LoginName"`
	} `json:"UserProfile"`
}

func ParseWhois(raw []byte) *Profile {
	var envelope whoisEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Node == nil || envelope.Node.Name == "" {
		return nil
	}
	profile := &Profile{Node: strings.TrimSuffix(envelope.Node.Name, ".")}
	if envelope.UserProfile != nil {
		profile.Login = envelope.UserProfile.LoginName
	}
	return profile
}

// ParseServeIdentity reads the login Serve adds. Serve removes spoofed copies of these
// headers before adding its authenticated identity. The gateway still listens on loopback
// so requests cannot bypass it.
func ParseServeIdentity(header http.Header) *Profile {
	logins := header.Values("Tailscale-User-Login")
	if len(logins) != 1 || logins[0] == "" {
		return nil
	}
	return &Profile{Login: logins[0]}
}

// Identity answers "who is this peer" using tailscaled's own whois, rather than us
// matching addresses ourselves. Cached briefly because it is a subprocess on the
// request path.
type Identity struct {
	binary  string
	ttl     time.Duration
	allowed map[string]bool

	mu    sync.Mutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	at      time.Time
	profile *Profile
}

func NewIdentity(allowedLogins []string, ttl time.Duration) *Identity {
	if ttl == 0 {
		ttl = time.Minute
	}
	allowed := make(map[string]bool, len(allowedLogins))
	for _, login := range allowedLogins {
		if login != "" {
			allowed[strings.ToLower(login)] = true
		}
	}
	return &Identity{binary: Find(), ttl: ttl, allowed: allowed, cache: map[string]cacheEntry{}}
}

func (identity *Identity) accept(profile *Profile) *Profile {
	if profile == nil {
		return nil
	}
	if len(identity.allowed) > 0 && !identity.allowed[strings.ToLower(profile.Login)] {
		return nil
	}
	return profile
}

func (identity *Identity) IdentifyHeaders(header http.Header) bool {
	return identity.accept(ParseServeIdentity(header)) != nil
}

func (identity *Identity) Identify(address string) bool {
	ip := strings.TrimPrefix(address, "::ffff:")
	if ip == "" {
		return false
	}

	identity.mu.Lock()
	cached, ok := identity.cache[ip]
	identity.mu.Unlock()
	if ok && time.Since(cached.at) < identity.ttl {
		return cached.profile != nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	profile := identity.accept(ParseWhois(runJSON(ctx, identity.binary, []string{"whois", "--json", ip}, 3*time.Second)))

	identity.mu.Lock()
	identity.cache[ip] = cacheEntry{at: time.Now(), profile: profile}
	identity.mu.Unlock()
	return profile != nil
}

type ServeStatus struct {
	TSOrigin string
	Funnel   bool
}

type serveEnvelope struct {
	Web map[string]struct {
		Handlers map[string]struct {
			Proxy string `json:"Proxy"`
		} `json:"Handlers"`
	} `json:"Web"`
	AllowFunnel map[string]bool `json:"AllowFunnel"`
}

func ParseServeStatus(raw []byte, port int) ServeStatus {
	var envelope serveEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Web == nil {
		return ServeStatus{}
	}
	suffix := ":" + strconv.Itoa(port)
	for hostPort, config := range envelope.Web {
		proxy := config.Handlers["/"].Proxy
		if proxy == "" || !strings.HasSuffix(proxy, suffix) {
			continue
		}
		return ServeStatus{
			TSOrigin: "https://" + strings.TrimSuffix(hostPort, ":443"),
			Funnel:   envelope.AllowFunnel[hostPort],
		}
	}
	return ServeStatus{}
}

type ServeOffer struct {
	TSOrigin  string
	Funnel    bool
	EnableURL string
}

var enableURLPattern = regexp.MustCompile(`https://login\.tailscale\.com/f/serve\?\S+`)

// OfferServe returns the exposure the browser can actually reach, plus the one-click URL
// that turns Serve on when it is off — Tailscale gates it behind a single visit.
//
// `tailscale serve --bg` blocks for ~30s when Serve is off for the tailnet, so this never
// runs before listen(). TLS is deliberately separate from direct tailnet binding: a cloud
// gateway stays on loopback and lets Tailscale Serve authenticate every request.
func OfferServe(ctx context.Context, port int) ServeOffer {
	binary := Find()
	if existing := ParseServeStatus(runJSON(ctx, binary, []string{"serve", "status", "--json"}, 3*time.Second), port); existing.TSOrigin != "" {
		return ServeOffer{TSOrigin: existing.TSOrigin, Funnel: existing.Funnel}
	}

	attempt := runText(ctx, binary, []string{"serve", "--bg", strconv.Itoa(port)}, 30*time.Second)
	if enableURL := enableURLPattern.FindString(string(attempt)); enableURL != "" {
		return ServeOffer{EnableURL: enableURL}
	}

	served := ParseServeStatus(runJSON(ctx, binary, []string{"serve", "status", "--json"}, 3*time.Second), port)
	return ServeOffer{TSOrigin: served.TSOrigin, Funnel: served.Funnel}
}

func runJSON(ctx context.Context, binary string, args []string, timeout time.Duration) []byte {
	return runText(ctx, binary, args, timeout)
}

// runText returns stdout only, and returns it even on a non-zero exit: warnings go to
// stderr, and `tailscale serve` reports "not enabled" on a non-zero exit in some versions.
func runText(ctx context.Context, binary string, args []string, timeout time.Duration) []byte {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var stdout strings.Builder
	command := exec.CommandContext(ctx, binary, args...)
	command.Stdout = &stdout
	_ = command.Run()
	return []byte(stdout.String())
}
