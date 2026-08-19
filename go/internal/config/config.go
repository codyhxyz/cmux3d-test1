// Package config is the Go port of the gateway half of src/server/config.js.
//
// The cloud/AgentCore options (readCloudOptions) are deliberately absent: the minter and
// the AgentCore control plane still run on Node. See go/README.md.
package config

import (
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/codyhxyz/coding-cube/go/internal/connection"
	"github.com/codyhxyz/coding-cube/go/internal/herdr"
	"github.com/codyhxyz/coding-cube/go/internal/tokenstore"
)

type Options struct {
	Host      string
	Port      int
	Cwd       string
	Shell     string
	Herdr     string
	Workspace string
	WebOrigin string

	GatewayOnly bool
	Token       string
	Rotated     bool

	Expose         bool
	ServeOnly      bool
	TailscaleUsers []string
	TrustTailnet   bool

	// CloudRequested is kept so `--cloud` is a loud error rather than a gateway that
	// quietly ignored the flag: this binary has no minter to satisfy it.
	CloudRequested bool
}

func Read(env func(string) string, argv []string) (Options, error) {
	rotate := env("CODING_CUBE_ROTATE_TOKEN") == "1" || slices.Contains(argv, "--rotate-token")

	cwd := env("CODING_CUBE_WORKDIR")
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	shell := env("CODING_CUBE_SHELL")
	if shell == "" {
		shell = env("SHELL")
	}
	webOrigin := env("CODING_CUBE_WEB_ORIGIN")
	if webOrigin == "" {
		webOrigin = connection.DefaultWebOrigin
	}
	workspace := env("CODING_CUBE_WORKSPACE")
	if workspace == "" {
		workspace = herdr.DefaultWorkspace
	}
	host := env("HOST")
	if host == "" {
		host = connection.DefaultHostAddress
	}
	port := connection.DefaultHostPort
	if raw := env("PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return Options{}, err
		}
		port = parsed
	}

	// An unset or "0" CODING_CUBE_HERDR means the plain-shell path; any other value names
	// the executable.
	herdrExecutable := env("CODING_CUBE_HERDR")
	if herdrExecutable == "0" {
		herdrExecutable = ""
	}

	options := Options{
		Host:        host,
		Port:        port,
		Cwd:         cwd,
		Shell:       shell,
		Herdr:       herdrExecutable,
		Workspace:   workspace,
		WebOrigin:   webOrigin,
		GatewayOnly: env("CODING_CUBE_GATEWAY_ONLY") == "1",
		Rotated:     rotate && env("CODING_CUBE_TOKEN") == "",

		Expose:    env("CODING_CUBE_TAILSCALE") == "1" || slices.Contains(argv, "--expose"),
		ServeOnly: env("CODING_CUBE_TAILSCALE") == "serve",
		// Tailscale authenticates your devices already; asking them for a code too buys
		// nothing. CODING_CUBE_REQUIRE_CODE=1 demands one anyway.
		TrustTailnet:   env("CODING_CUBE_REQUIRE_CODE") != "1",
		CloudRequested: env("CODING_CUBE_CLOUD") == "1" || slices.Contains(argv, "--cloud"),
	}

	for _, login := range strings.Split(env("CODING_CUBE_TAILSCALE_USERS"), ",") {
		if trimmed := strings.TrimSpace(login); trimmed != "" {
			options.TailscaleUsers = append(options.TailscaleUsers, trimmed)
		}
	}

	// The env override is honoured but never written to disk.
	if supplied := env("CODING_CUBE_TOKEN"); supplied != "" {
		options.Token = supplied
		return options, nil
	}
	var token string
	var err error
	if rotate {
		token, err = tokenstore.Rotate(env)
	} else {
		token, err = tokenstore.LoadOrCreate(env)
	}
	if err != nil {
		return Options{}, err
	}
	options.Token = token
	return options, nil
}
