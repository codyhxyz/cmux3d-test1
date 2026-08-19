// Package tokenstore is the Go port of src/server/token-store.js.
package tokenstore

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,}$`)

// Env is the process environment, injectable so tests do not touch $HOME.
type Env func(string) string

func OSEnv(key string) string { return os.Getenv(key) }

func StateDir(env Env) string {
	if dir := env("CODING_CUBE_STATE_DIR"); dir != "" {
		return dir
	}
	home := env("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".coding-cube")
}

// LoadOrCreate returns the pairing code, minting one if the file is missing or corrupt.
// Pairing survives restarts so a phone stays paired; the file is the only secret on disk.
func LoadOrCreate(env Env) (string, error) {
	dir := StateDir(env)
	file := filepath.Join(dir, "token")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}

	if raw, err := os.ReadFile(file); err == nil {
		existing := strings.TrimSpace(string(raw))
		if tokenPattern.MatchString(existing) {
			// Repair permissions on a file that predates the 0600 mode.
			_ = os.Chmod(file, 0o600)
			return existing, nil
		}
	}

	token, err := New()
	if err != nil {
		return "", err
	}
	return write(file, token)
}

func New() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func Rotate(env Env) (string, error) {
	if err := os.Remove(filepath.Join(StateDir(env), "token")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return LoadOrCreate(env)
}

// LoadCloud reads the hosted cube's pairing code. Deliberately never created on demand,
// unlike the local token: inventing a code here would produce a QR that pairs a phone to
// nothing. The hosted copy lives in Cloudflare, which will not read a secret back, so this
// file is the only copy a Mac can put in a QR.
func LoadCloud(env Env) string {
	if supplied := strings.TrimSpace(env("CUBE_PAIRING_TOKEN")); supplied != "" {
		return supplied
	}
	raw, err := os.ReadFile(cloudTokenFile(env))
	if err != nil {
		return ""
	}
	stored := strings.TrimSpace(string(raw))
	if !tokenPattern.MatchString(stored) {
		return ""
	}
	return stored
}

func SaveCloud(token string, env Env) (string, error) {
	if !tokenPattern.MatchString(token) {
		return "", fmt.Errorf("a pairing code is 16 or more letters, digits, - or _")
	}
	if err := os.MkdirAll(StateDir(env), 0o700); err != nil {
		return "", err
	}
	return write(cloudTokenFile(env), token)
}

func cloudTokenFile(env Env) string { return filepath.Join(StateDir(env), "cloud-token") }

func write(file, token string) (string, error) {
	if err := os.WriteFile(file, []byte(token+"\n"), 0o600); err != nil {
		return "", err
	}
	// WriteFile's mode only applies when it creates the file; an existing one keeps
	// whatever permissions it had.
	if err := os.Chmod(file, 0o600); err != nil {
		return "", err
	}
	return token, nil
}
