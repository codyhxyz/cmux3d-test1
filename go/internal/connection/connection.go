// Package connection is the server-side half of public/app/connection-config.js.
// Only the pieces the gateway needs are ported; the browser keeps its own copy.
package connection

import (
	"net/url"
	"strings"
)

const (
	DefaultHostAddress = "127.0.0.1"
	DefaultHostPort    = 8064
	DefaultWebOrigin   = "https://codingcube.codyh.xyz"
)

var loopbackHostnames = map[string]bool{
	"127.0.0.1": true, "localhost": true, "[::1]": true, "::1": true,
}

func IsLoopbackHostname(hostname string) bool { return loopbackHostnames[hostname] }

func IsLoopbackAddress(address string) bool {
	if address == "" {
		return false
	}
	return IsLoopbackHostname(strings.TrimPrefix(address, "::ffff:"))
}

// IsLoopbackOrigin parses an Origin header and reports whether it names this machine.
func IsLoopbackOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return IsLoopbackHostname(parsed.Hostname())
}

func PairingURL(webOrigin, hostOrigin, token string) string {
	return webOrigin + "/#host=" + url.QueryEscape(hostOrigin) + "&token=" + url.QueryEscape(token)
}
