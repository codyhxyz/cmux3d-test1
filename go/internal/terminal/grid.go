// Package terminal is the Go port of src/server/terminal-grid.js.
package terminal

import (
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"

	"github.com/codyhxyz/coding-cube/go/internal/facecount"
	"github.com/codyhxyz/coding-cube/go/internal/herdr"
	"github.com/codyhxyz/coding-cube/go/internal/shell"
)

const (
	faceMin = 0
	// 0-based, so the last addressable face is the tenth — the AgentCore ceiling, not a
	// number of our own choosing. See facecount.Max.
	faceMax = facecount.Max - 1
	slotMin = 0
	// Faces x slots is the addressable grid; the two bounds are independent and nothing
	// here has ever assumed one from the other.
	slotMax = 3

	historyLimit = 1_000_000

	initialCols = 90
	initialRows = 28
)

var resizeMagic = [4]byte{'C', 'U', 'B', 'E'}

// Conn is the half of a websocket the grid needs. The gateway supplies the real one; tests
// supply a fake.
type Conn interface {
	// SendText delivers one text frame. It must be safe to call from any goroutine.
	SendText(data []byte) error
	// Close ends the connection with a websocket close code.
	Close(code int, reason string)
}

// Grid owns every PTY on this host, keyed by face and slot.
type Grid struct {
	cwd       string
	shell     string
	herdr     *herdr.Client
	workspace string

	mu             sync.Mutex
	sessions       map[string]*session
	targets        []string
	faceCount      int
	preparedAt     time.Time
	workspaceReady bool

	// prepareMu serialises reconciliation. Widening the cube reconnects every face at
	// once, so ten of these arrive together asking for ten different widths. Overlapping
	// them lets a plain snapshot read land between a widening and its result and publish
	// the SHORTER target list, which leaves faces 7..10 with "no terminal on this host".
	// One at a time, so the last word always belongs to the widest request.
	prepareMu sync.Mutex
}

type Options struct {
	Cwd       string
	Shell     string
	Herdr     string // executable name or path; "" disables the herdr path
	Workspace string
	FaceCount int
}

func NewGrid(opts Options) (*Grid, error) {
	cwd := opts.Cwd
	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	}
	workspace := opts.Workspace
	if workspace == "" {
		workspace = herdr.DefaultWorkspace
	}
	faceCount := opts.FaceCount
	if faceCount == 0 {
		faceCount = facecount.Default
	}

	grid := &Grid{
		cwd:       cwd,
		shell:     shell.Choose(opts.Shell),
		workspace: workspace,
		faceCount: facecount.ClampDefault(faceCount).Faces,
		sessions:  map[string]*session{},
	}
	if opts.Herdr != "" {
		resolved := shell.ResolveExecutable(opts.Herdr)
		if resolved == "" {
			return nil, fmt.Errorf("executable not found: %s", opts.Herdr)
		}
		grid.herdr = herdr.New(resolved)
	}
	return grid, nil
}

func (grid *Grid) UsesHerdr() bool { return grid.herdr != nil }

func (grid *Grid) Herdr() *herdr.Client { return grid.herdr }

func (grid *Grid) Workspace() string { return grid.workspace }

// Prepare reconciles the herdr workspace to at least faceCount faces.
//
// The count only ever grows. A browser that widens its cube asks for a face this workspace
// has never had a tab for, and that request is the whole protocol on the local path —
// there is no second endpoint to call. Narrowing it again is the browser rendering fewer
// faces; the tabs stay, because one of them may hold an agent mid-task.
func (grid *Grid) Prepare(ctx context.Context, faceCount int) error {
	grid.mu.Lock()
	// The current count is the fallback, so a nonsense argument can only leave the
	// workspace as wide as it already is — never narrow it. Raised before queueing, so
	// the runs below can only ever see the width grow.
	wanted := facecount.Clamp(max(faceCount, grid.faceCount), true, grid.faceCount).Faces
	grew := wanted > grid.faceCount
	grid.faceCount = wanted
	grid.mu.Unlock()

	if grid.herdr == nil {
		return nil
	}

	grid.prepareMu.Lock()
	defer grid.prepareMu.Unlock()
	return grid.prepareOnce(ctx, wanted, grew)
}

func (grid *Grid) prepareOnce(ctx context.Context, wanted int, grew bool) error {
	grid.mu.Lock()
	ready, preparedAt := grid.workspaceReady, grid.preparedAt
	grid.mu.Unlock()

	// A face with no terminal id yet is the one case the throttle must not swallow.
	if !grew && time.Since(preparedAt) < time.Second {
		return nil
	}

	var state []herdr.Face
	var err error
	if ready && !grew {
		state, err = grid.herdr.ReadState(ctx, grid.workspace, -1)
	} else {
		state, err = grid.herdr.EnsureWorkspace(ctx, grid.workspace, grid.cwd, wanted)
	}
	if err != nil {
		return err
	}

	grid.mu.Lock()
	grid.workspaceReady = true
	grid.mu.Unlock()
	grid.SetTargets(terminalIDs(state))
	return nil
}

func terminalIDs(state []herdr.Face) []string {
	ids := make([]string, len(state))
	for index, face := range state {
		ids[index] = face.TerminalID
	}
	return ids
}

// SetTargets publishes the terminal ids each face maps to, closing any session whose face
// now points somewhere else.
func (grid *Grid) SetTargets(targets []string) {
	grid.mu.Lock()
	previous := grid.targets
	grid.targets = append([]string(nil), targets...)
	grid.preparedAt = time.Now()

	var stale []*session
	for _, current := range grid.sessions {
		face := current.face
		if face < len(previous) && previous[face] != "" && face < len(targets) && previous[face] != targets[face] {
			stale = append(stale, current)
		}
	}
	grid.mu.Unlock()

	for _, current := range stale {
		grid.closeSession(current)
	}
}

// Attach wires one websocket to one face and slot, replaying that session's scrollback
// first. It blocks until the socket closes, so the caller's read loop lives here.
func (grid *Grid) Attach(ctx context.Context, faceValue, slotValue int, conn Conn, reader func() (isText bool, data []byte, err error)) error {
	face := clamp(faceValue, faceMin, faceMax)
	slot := clamp(slotValue, slotMin, slotMax)
	if err := grid.Prepare(ctx, face+1); err != nil {
		return err
	}

	current, err := grid.session(face, slot)
	if err != nil {
		return err
	}

	if history := current.snapshotHistory(); len(history) > 0 {
		if err := conn.SendText(history); err != nil {
			return err
		}
	}
	current.addClient(conn)
	defer func() {
		if current.removeClient(conn) {
			grid.closeSession(current)
		}
	}()

	for {
		isText, data, err := reader()
		if err != nil {
			return nil // A closed socket is an ordinary detach, not a failure.
		}
		if isText {
			current.write(data)
			continue
		}
		if len(data) != 8 || [4]byte(data[0:4]) != resizeMagic {
			current.write(data)
			continue
		}

		cols := binary.BigEndian.Uint16(data[4:6])
		rows := binary.BigEndian.Uint16(data[6:8])
		if cols < 20 || cols > 220 || rows < 8 || rows > 80 {
			conn.Close(1003, "invalid terminal size")
			return nil
		}
		if err := current.resize(cols, rows); err != nil {
			_ = conn.SendText([]byte("\r\n\x1b[31m" + err.Error() + "\x1b[0m\r\n"))
		}
	}
}

func (grid *Grid) CloseAll() {
	grid.mu.Lock()
	sessions := make([]*session, 0, len(grid.sessions))
	for _, current := range grid.sessions {
		sessions = append(sessions, current)
	}
	grid.mu.Unlock()
	for _, current := range sessions {
		grid.closeSession(current)
	}
}

func (grid *Grid) closeSession(current *session) {
	grid.mu.Lock()
	if grid.sessions[current.id] != current {
		grid.mu.Unlock()
		return
	}
	delete(grid.sessions, current.id)
	grid.mu.Unlock()
	current.shutdown(1001, "terminal detached")
}

func (grid *Grid) session(face, slot int) (*session, error) {
	id := strconv.Itoa(face) + "." + strconv.Itoa(slot)

	grid.mu.Lock()
	if existing, ok := grid.sessions[id]; ok {
		grid.mu.Unlock()
		return existing, nil
	}
	targets := grid.targets
	grid.mu.Unlock()

	// Named rather than spawned with an empty argument: without this a face whose tab
	// could not be created reaches the PTY as `herdr terminal attach ""`, and the browser
	// is told the shell exited instead of what actually happened.
	var target string
	if grid.herdr != nil {
		if face >= len(targets) || targets[face] == "" {
			return nil, fmt.Errorf("face %d has no terminal on this host", face+1)
		}
		target = targets[face]
	}

	command := grid.command(face, slot, id, target)
	file, err := pty.StartWithSize(command, &pty.Winsize{Cols: initialCols, Rows: initialRows})
	if err != nil {
		return nil, err
	}

	current := &session{
		id:      id,
		face:    face,
		slot:    slot,
		pty:     file,
		command: command,
		clients: map[Conn]struct{}{},
	}

	grid.mu.Lock()
	// Another Attach may have won the race while the PTY was starting. Keep theirs and
	// discard ours rather than leaking a second shell onto the same face.
	if existing, ok := grid.sessions[id]; ok {
		grid.mu.Unlock()
		current.shutdown(1001, "terminal detached")
		return existing, nil
	}
	grid.sessions[id] = current
	grid.mu.Unlock()

	go current.pump(func() { grid.forget(current) })
	return current, nil
}

func (grid *Grid) forget(current *session) {
	grid.mu.Lock()
	if grid.sessions[current.id] == current {
		delete(grid.sessions, current.id)
	}
	grid.mu.Unlock()
}

func (grid *Grid) command(face, slot int, id, target string) *exec.Cmd {
	name := grid.shell
	var args []string
	if grid.herdr != nil {
		name = grid.herdr.Executable
		// --takeover is not optional. Closing a socket kills this PTY, but the herdr side
		// of the attach takes a moment longer to let go, and herdr refuses a second attach
		// in that window: "terminal <id> already has an attached client; retry with
		// --takeover". Measured on a live container — reconnecting to a face with no gap
		// after disconnecting returned 548 bytes of that refusal, the PTY exited 1, and
		// the socket closed 1012 "shell exited" instead of showing the terminal. A browser
		// page reload is exactly that sequence, so without this a refresh reliably kills
		// the face it reloads.
		//
		// Takeover is also the right semantics rather than a workaround: the gateway is the
		// only thing that ever attaches to the cube's terminals, so a client already holding
		// one is always a stale attach that has not finished dying, never a second user
		// whose session we would be stealing.
		//
		// The flag goes AFTER the terminal id even though `herdr terminal attach --help`
		// prints `[OPTIONS] <TERMINAL_ID>`. Measured: the documented order makes herdr exit
		// 2 with "unknown option: term_…" and the face never opens at all.
		args = []string{"--session", "default", "terminal", "attach", target, "--takeover"}
	}

	command := exec.Command(name, args...)
	command.Dir = grid.cwd
	command.Env = gridEnv(face, slot, id)
	return command
}

func gridEnv(face, slot int, id string) []string {
	dropped := map[string]bool{
		"HERDR_ENV": true, "HERDR_SOCKET_PATH": true, "HERDR_PANE_ID": true, "HERDR_TAB_ID": true,
		"TERM": true, "COLORTERM": true,
		"CODING_CUBE_FACE": true, "CODING_CUBE_SLOT": true, "CODING_CUBE_SESSION": true,
	}
	env := make([]string, 0, len(os.Environ())+6)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !dropped[key] {
			env = append(env, entry)
		}
	}
	return append(env,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"CODING_CUBE_FACE="+strconv.Itoa(face),
		"CODING_CUBE_SLOT="+strconv.Itoa(slot),
		"CODING_CUBE_SESSION="+id,
	)
}

func clamp(value, low, high int) int { return min(high, max(low, value)) }
