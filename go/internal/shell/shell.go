// Package shell is the Go port of src/server/shell.js.
//
// repairDarwinPtyHelper() has no counterpart here and needs none: it existed to chmod
// node-pty's prebuilt spawn-helper binary, and Go's PTY support is a syscall rather than
// a shipped executable.
package shell

import (
	"os"
	"path/filepath"
	"strings"
)

// ResolveExecutable finds an executable the way execvp would, returning "" when nothing
// on PATH matches. A command containing a separator is taken as a path and checked as-is.
func ResolveExecutable(command string) string {
	if command == "" {
		return ""
	}
	var candidates []string
	if strings.ContainsRune(command, filepath.Separator) {
		candidates = []string{command}
	} else {
		for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
			if dir == "" {
				continue
			}
			candidates = append(candidates, filepath.Join(dir, command))
		}
	}
	for _, candidate := range candidates {
		if isExecutable(candidate) {
			return candidate
		}
	}
	return ""
}

// Choose falls back through the shells a Mac or a Linux box is most likely to have,
// ending at /bin/sh, which is the one every POSIX system is required to provide.
func Choose(preferred string) string {
	for _, candidate := range []string{preferred, "/bin/zsh", "/bin/bash", "/bin/sh"} {
		if resolved := ResolveExecutable(candidate); resolved != "" {
			return resolved
		}
	}
	return "/bin/sh"
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0o111 != 0
}
