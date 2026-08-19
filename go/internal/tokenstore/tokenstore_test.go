package tokenstore

import (
	"os"
	"path/filepath"
	"testing"
)

func envFor(dir string) Env {
	return func(key string) string {
		if key == "CODING_CUBE_STATE_DIR" {
			return dir
		}
		return ""
	}
}

func TestLoadOrCreateMintsThenReuses(t *testing.T) {
	dir := t.TempDir()
	env := envFor(dir)

	first, err := LoadOrCreate(env)
	if err != nil {
		t.Fatal(err)
	}
	if !tokenPattern.MatchString(first) {
		t.Fatalf("minted token %q does not match the pairing-code shape", first)
	}

	second, err := LoadOrCreate(env)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("the pairing code must survive a restart")
	}
}

// The file is the only secret on disk, so it is owner-read/write and nothing else.
func TestTokenFilePermissions(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadOrCreate(envFor(dir)); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(filepath.Join(dir, "token"))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("token file mode = %o, want 600", mode)
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	// t.TempDir() makes the directory itself, so only assert the group/other bits the
	// store is responsible for when it creates one.
	if dirInfo.Mode().Perm()&0o077 != 0 && os.Getenv("CI") == "" {
		t.Logf("state dir mode is %o (created by the test harness, not the store)", dirInfo.Mode().Perm())
	}
}

// A corrupt or truncated file must be replaced, not returned as a pairing code.
func TestCorruptTokenIsReplaced(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "token"), []byte("short\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	token, err := LoadOrCreate(envFor(dir))
	if err != nil {
		t.Fatal(err)
	}
	if token == "short" || !tokenPattern.MatchString(token) {
		t.Fatalf("token = %q, want a freshly minted code", token)
	}
}

func TestRotateMintsANewCode(t *testing.T) {
	dir := t.TempDir()
	env := envFor(dir)

	first, err := LoadOrCreate(env)
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := Rotate(env)
	if err != nil {
		t.Fatal(err)
	}
	if rotated == first {
		t.Fatal("Rotate returned the old code")
	}
	// Rotating a state dir that has no token yet is not an error.
	if _, err := Rotate(envFor(t.TempDir())); err != nil {
		t.Fatalf("Rotate on an empty state dir: %v", err)
	}
}

// The cloud code is deliberately never created on demand: inventing one here would
// produce a QR that pairs a phone to nothing.
func TestCloudTokenIsNeverInvented(t *testing.T) {
	dir := t.TempDir()
	if got := LoadCloud(envFor(dir)); got != "" {
		t.Fatalf("LoadCloud = %q, want empty", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "cloud-token")); !os.IsNotExist(err) {
		t.Fatal("LoadCloud created a file")
	}

	if _, err := SaveCloud("a-valid-cloud-token-1234", envFor(dir)); err != nil {
		t.Fatal(err)
	}
	if got := LoadCloud(envFor(dir)); got != "a-valid-cloud-token-1234" {
		t.Fatalf("LoadCloud = %q", got)
	}
	if _, err := SaveCloud("tooshort", envFor(dir)); err == nil {
		t.Fatal("SaveCloud accepted a code below the 16-character floor")
	}
}

func TestStateDirFallsBackToHome(t *testing.T) {
	env := func(key string) string {
		if key == "HOME" {
			return "/home/someone"
		}
		return ""
	}
	if got := StateDir(env); got != "/home/someone/.coding-cube" {
		t.Fatalf("StateDir = %q", got)
	}
}
