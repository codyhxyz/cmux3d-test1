package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"unicode/utf8"

	"github.com/creack/pty"
)

// session is one PTY and every socket currently watching it.
type session struct {
	id      string
	face    int
	slot    int
	pty     *os.File
	command *exec.Cmd

	mu      sync.Mutex
	clients map[Conn]struct{}
	history []byte
	closed  bool
}

func (s *session) addClient(conn Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clients[conn] = struct{}{}
}

// removeClient reports whether that was the last one, which is the signal to kill the PTY.
func (s *session) removeClient(conn Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.clients, conn)
	return len(s.clients) == 0
}

func (s *session) snapshotHistory() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.history...)
}

func (s *session) write(data []byte) {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return
	}
	// A dead PTY is an ordinary race with onExit, not something to report: the exit path
	// has already told every client and is closing their sockets.
	_, _ = s.pty.Write(data)
}

func (s *session) resize(cols, rows uint16) error {
	if err := pty.Setsize(s.pty, &pty.Winsize{Cols: cols, Rows: rows}); err != nil {
		return fmt.Errorf("resize failed: %w", err)
	}
	return nil
}

// pump reads the PTY until it ends, fanning every chunk out to the attached sockets and
// keeping the scrollback the next client replays.
//
// The read loop must never block on a slow socket, or one stalled phone freezes the shell
// for every other viewer of that face. Each client owns a buffered writer goroutine
// (see fanoutConn); a client that cannot keep up is dropped rather than throttling the PTY.
func (s *session) pump(forget func()) {
	buffer := make([]byte, 32*1024)
	// node-pty decoded PTY output to a string before handing it over, which buffered
	// partial UTF-8 sequences across reads. We send text frames too, so a multi-byte rune
	// split across two reads has to be held back the same way or the frame is invalid.
	var carry []byte

	for {
		count, err := s.pty.Read(buffer)
		if count > 0 {
			chunk := append(carry, buffer[:count]...)
			chunk, carry = splitRunes(chunk)
			if len(chunk) > 0 {
				s.broadcast(chunk)
			}
		}
		if err != nil {
			break
		}
	}

	// Flush anything the shell left mid-rune so the tail is not silently dropped.
	if len(carry) > 0 {
		s.broadcast(carry)
	}

	forget()
	s.shutdown(1012, "shell exited")
}

func (s *session) broadcast(chunk []byte) {
	s.mu.Lock()
	s.history = append(s.history, chunk...)
	if len(s.history) > historyLimit {
		s.history = append([]byte(nil), s.history[len(s.history)-historyLimit:]...)
	}
	clients := make([]Conn, 0, len(s.clients))
	for conn := range s.clients {
		clients = append(clients, conn)
	}
	s.mu.Unlock()

	for _, conn := range clients {
		_ = conn.SendText(chunk)
	}
}

// shutdown closes the PTY and every attached socket. Safe to call more than once, and
// from either the exit path or the last-client-left path.
func (s *session) shutdown(code int, reason string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	clients := make([]Conn, 0, len(s.clients))
	for conn := range s.clients {
		clients = append(clients, conn)
	}
	s.clients = map[Conn]struct{}{}
	s.mu.Unlock()

	if code == 1012 {
		notice := fmt.Sprintf("\r\n\x1b[31mprocess ended (%s); reconnecting…\x1b[0m\r\n", s.exitStatus())
		for _, conn := range clients {
			_ = conn.SendText([]byte(notice))
		}
	}
	for _, conn := range clients {
		conn.Close(code, reason)
	}

	_ = s.pty.Close()
	if s.command.Process != nil {
		_ = s.command.Process.Kill()
	}
	// Reap it, so a long-lived gateway does not accumulate zombies.
	go func() { _ = s.command.Wait() }()
}

func (s *session) exitStatus() string {
	state := s.command.ProcessState
	if state == nil {
		return "signal"
	}
	return fmt.Sprintf("%d", state.ExitCode())
}

// splitRunes returns the largest prefix of data ending on a rune boundary, plus the
// incomplete tail to carry into the next read. A tail that is not a valid rune start is
// passed through rather than held forever — the shell may simply be emitting raw bytes.
func splitRunes(data []byte) (complete, carry []byte) {
	for scan := 1; scan <= 4 && scan <= len(data); scan++ {
		tail := data[len(data)-scan:]
		if utf8.RuneStart(tail[0]) {
			if r, size := utf8.DecodeRune(tail); r == utf8.RuneError && size <= 1 {
				// A truncated multi-byte sequence: hold it back for the next read.
				return data[:len(data)-scan], append([]byte(nil), tail...)
			}
			return data, nil
		}
	}
	return data, nil
}
