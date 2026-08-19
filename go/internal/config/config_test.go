package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codyhxyz/coding-cube/go/internal/herdr"
)

// envFrom builds the Env accessor from a map, so a test never reads the real environment.
func envFrom(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestDefaults(t *testing.T) {
	dir := t.TempDir()
	options, err := Read(envFrom(map[string]string{"CODING_CUBE_STATE_DIR": dir}), nil)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if options.Host != "127.0.0.1" || options.Port != 8064 {
		t.Fatalf("host/port = %s:%d", options.Host, options.Port)
	}
	if options.WebOrigin != "https://codingcube.codyh.xyz" {
		t.Fatalf("webOrigin = %q", options.WebOrigin)
	}
	if options.Workspace != herdr.DefaultWorkspace {
		t.Fatalf("workspace = %q", options.Workspace)
	}
	// Tailscale authenticates your devices already, so a code is not demanded by default.
	if !options.TrustTailnet {
		t.Fatal("TrustTailnet should default to true")
	}
	if options.Herdr != "" || options.GatewayOnly || options.Expose {
		t.Fatalf("unexpected non-default: %+v", options)
	}
	if len(options.Token) < 16 {
		t.Fatalf("token = %q, want a minted pairing code", options.Token)
	}
}

// An unset or "0" CODING_CUBE_HERDR is the plain-shell path; any other value names the
// executable.
func TestHerdrToggle(t *testing.T) {
	for value, want := range map[string]string{"": "", "0": "", "herdr": "herdr", "/opt/herdr": "/opt/herdr"} {
		options, err := Read(envFrom(map[string]string{
			"CODING_CUBE_STATE_DIR": t.TempDir(),
			"CODING_CUBE_HERDR":     value,
		}), nil)
		if err != nil {
			t.Fatalf("Read(%q): %v", value, err)
		}
		if options.Herdr != want {
			t.Fatalf("CODING_CUBE_HERDR=%q gave Herdr=%q, want %q", value, options.Herdr, want)
		}
	}
}

func TestFlagsAndEnvAgree(t *testing.T) {
	dir := t.TempDir()
	viaFlag, err := Read(envFrom(map[string]string{"CODING_CUBE_STATE_DIR": dir}), []string{"--expose", "--cloud"})
	if err != nil {
		t.Fatal(err)
	}
	viaEnv, err := Read(envFrom(map[string]string{
		"CODING_CUBE_STATE_DIR": dir,
		"CODING_CUBE_TAILSCALE": "1",
		"CODING_CUBE_CLOUD":     "1",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !viaFlag.Expose || !viaEnv.Expose {
		t.Fatal("--expose and CODING_CUBE_TAILSCALE=1 must agree")
	}
	if !viaFlag.CloudRequested || !viaEnv.CloudRequested {
		t.Fatal("--cloud and CODING_CUBE_CLOUD=1 must agree")
	}
}

// The env override is honoured but never written to disk.
func TestTokenOverrideIsNotPersisted(t *testing.T) {
	dir := t.TempDir()
	options, err := Read(envFrom(map[string]string{
		"CODING_CUBE_STATE_DIR": dir,
		"CODING_CUBE_TOKEN":     "supplied-token-value-123",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if options.Token != "supplied-token-value-123" {
		t.Fatalf("token = %q", options.Token)
	}
	if _, err := os.Stat(filepath.Join(dir, "token")); !os.IsNotExist(err) {
		t.Fatal("the supplied token was written to disk")
	}
}

func TestTokenIsStableAcrossReadsAndRotates(t *testing.T) {
	dir := t.TempDir()
	env := envFrom(map[string]string{"CODING_CUBE_STATE_DIR": dir})

	first, err := Read(env, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Pairing survives restarts so a phone stays paired.
	second, err := Read(env, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Token != second.Token {
		t.Fatal("the pairing code changed between reads")
	}

	rotated, err := Read(env, []string{"--rotate-token"})
	if err != nil {
		t.Fatal(err)
	}
	if rotated.Token == first.Token {
		t.Fatal("--rotate-token did not mint a new code")
	}
	if !rotated.Rotated {
		t.Fatal("Rotated should be set so the CLI can warn that phones must pair again")
	}
}

func TestTailscaleUsersAreSplitAndTrimmed(t *testing.T) {
	options, err := Read(envFrom(map[string]string{
		"CODING_CUBE_STATE_DIR":       t.TempDir(),
		"CODING_CUBE_TAILSCALE_USERS": " cody@example.com , , someone@example.com ",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(options.TailscaleUsers, "|") != "cody@example.com|someone@example.com" {
		t.Fatalf("users = %v", options.TailscaleUsers)
	}
}

func TestBadPortIsAnError(t *testing.T) {
	if _, err := Read(envFrom(map[string]string{
		"CODING_CUBE_STATE_DIR": t.TempDir(),
		"PORT":                  "not-a-port",
	}), nil); err == nil {
		t.Fatal("a non-numeric PORT should be an error, not a silent default")
	}
}
