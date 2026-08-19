package terminal

import (
	"bytes"
	"context"
	"encoding/binary"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeConn is a terminal.Conn that records what it was sent.
type fakeConn struct {
	mu     sync.Mutex
	frames [][]byte
	code   int
	reason string
	closed bool
}

func (f *fakeConn) SendText(data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.frames = append(f.frames, append([]byte(nil), data...))
	return nil
}

func (f *fakeConn) Close(code int, reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed, f.code, f.reason = true, code, reason
}

func (f *fakeConn) text() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(bytes.Join(f.frames, nil))
}

func (f *fakeConn) waitFor(t *testing.T, want string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := f.text(); strings.Contains(got, want) {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q; got %q", want, f.text())
	return ""
}

// scriptedReader turns a list of frames into the reader Attach expects, blocking on a
// channel afterwards so the attach stays open until the test releases it.
func scriptedReader(frames [][2]any, release <-chan struct{}) func() (bool, []byte, error) {
	index := 0
	return func() (bool, []byte, error) {
		if index < len(frames) {
			frame := frames[index]
			index++
			return frame[0].(bool), frame[1].([]byte), nil
		}
		<-release
		return false, nil, context.Canceled
	}
}

func newTestGrid(t *testing.T) *Grid {
	t.Helper()
	grid, err := NewGrid(Options{Cwd: t.TempDir(), Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("NewGrid: %v", err)
	}
	t.Cleanup(grid.CloseAll)
	return grid
}

func TestAttachRunsAShellAndEchoesOutput(t *testing.T) {
	grid := newTestGrid(t)
	conn := &fakeConn{}
	release := make(chan struct{})

	done := make(chan error, 1)
	go func() {
		done <- grid.Attach(context.Background(), 0, 0,
			conn, scriptedReader([][2]any{{true, []byte("echo cube-is-alive\n")}}, release))
	}()

	conn.waitFor(t, "cube-is-alive")
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("Attach: %v", err)
	}
}

func TestHistoryReplaysToASecondClient(t *testing.T) {
	grid := newTestGrid(t)
	first := &fakeConn{}
	firstRelease := make(chan struct{})
	go grid.Attach(context.Background(), 0, 0,
		first, scriptedReader([][2]any{{true, []byte("echo remembered-line\n")}}, firstRelease))
	first.waitFor(t, "remembered-line")

	// A second viewer of the same face must arrive to the same screen, without the first
	// one having to leave.
	second := &fakeConn{}
	secondRelease := make(chan struct{})
	go grid.Attach(context.Background(), 0, 0, second, scriptedReader(nil, secondRelease))
	second.waitFor(t, "remembered-line")

	close(firstRelease)
	close(secondRelease)
}

func TestResizeFrameIsNotWrittenToTheShell(t *testing.T) {
	grid := newTestGrid(t)
	conn := &fakeConn{}
	release := make(chan struct{})

	resize := make([]byte, 8)
	copy(resize, resizeMagic[:])
	binary.BigEndian.PutUint16(resize[4:6], 100)
	binary.BigEndian.PutUint16(resize[6:8], 40)

	go grid.Attach(context.Background(), 0, 0, conn, scriptedReader([][2]any{
		{false, resize},
		{true, []byte("echo after-resize\n")},
	}, release))

	got := conn.waitFor(t, "after-resize")
	if strings.Contains(got, "CUBE") {
		t.Fatalf("the resize frame reached the shell as input: %q", got)
	}
	close(release)
}

func TestOutOfRangeResizeClosesTheSocket(t *testing.T) {
	grid := newTestGrid(t)
	conn := &fakeConn{}

	resize := make([]byte, 8)
	copy(resize, resizeMagic[:])
	binary.BigEndian.PutUint16(resize[4:6], 5000) // well past the 220-column ceiling
	binary.BigEndian.PutUint16(resize[6:8], 40)

	if err := grid.Attach(context.Background(), 0, 0, conn,
		scriptedReader([][2]any{{false, resize}}, make(chan struct{}))); err != nil {
		t.Fatalf("Attach: %v", err)
	}

	conn.mu.Lock()
	defer conn.mu.Unlock()
	if !conn.closed || conn.code != 1003 {
		t.Fatalf("expected close 1003, got closed=%v code=%d", conn.closed, conn.code)
	}
}

// An 8-byte binary frame that is not a CUBE frame is ordinary stdin, not a resize.
func TestEightBytesWithoutTheMagicIsStdin(t *testing.T) {
	grid := newTestGrid(t)
	conn := &fakeConn{}
	release := make(chan struct{})

	go grid.Attach(context.Background(), 0, 0, conn, scriptedReader([][2]any{
		{false, []byte("NOTCUBE\n")},
	}, release))

	conn.waitFor(t, "NOTCUBE")
	close(release)
}

func TestFaceAndSlotAreClamped(t *testing.T) {
	grid := newTestGrid(t)
	// Face 99 and slot 99 are out of range; they must land on the last addressable cell
	// rather than being rejected or creating an unbounded session id.
	release := make(chan struct{})
	go grid.Attach(context.Background(), 99, 99, &fakeConn{}, scriptedReader(nil, release))

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		grid.mu.Lock()
		_, ok := grid.sessions["9.3"]
		grid.mu.Unlock()
		if ok {
			close(release)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("expected the clamped session id 9.3 to exist")
}

func TestLastClientLeavingClosesTheSession(t *testing.T) {
	grid := newTestGrid(t)
	conn := &fakeConn{}
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		grid.Attach(context.Background(), 1, 0, conn, scriptedReader(nil, release))
		close(done)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		grid.mu.Lock()
		_, ok := grid.sessions["1.0"]
		grid.mu.Unlock()
		if ok {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	close(release)
	<-done

	grid.mu.Lock()
	_, ok := grid.sessions["1.0"]
	grid.mu.Unlock()
	if ok {
		t.Fatal("the session outlived its last client")
	}
}

func TestSplitRunesHoldsBackAPartialRune(t *testing.T) {
	// "é" is 0xC3 0xA9. A read that ends after 0xC3 must not be sent as a text frame.
	complete, carry := splitRunes([]byte{'a', 0xC3})
	if string(complete) != "a" || len(carry) != 1 || carry[0] != 0xC3 {
		t.Fatalf("split = %q, carry = %v", complete, carry)
	}

	// Once the continuation byte arrives the whole rune goes out.
	complete, carry = splitRunes(append(carry, 0xA9))
	if string(complete) != "é" || carry != nil {
		t.Fatalf("split = %q, carry = %v", complete, carry)
	}

	// Plain ASCII is never held back.
	complete, carry = splitRunes([]byte("hello"))
	if string(complete) != "hello" || carry != nil {
		t.Fatalf("split = %q, carry = %v", complete, carry)
	}
}
