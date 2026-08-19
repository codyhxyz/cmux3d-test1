// Package herdr is the Go port of src/server/herdr-state.js.
package herdr

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/codyhxyz/coding-cube/go/internal/facecount"
)

const DefaultWorkspace = "Coding Cube"

var eventTypes = []string{
	"workspace.renamed",
	"workspace.closed",
	"tab.created",
	"tab.renamed",
	"tab.closed",
	"pane.created",
	"pane.closed",
	"pane.moved",
	"pane.agent_detected",
}

type Workspace struct {
	WorkspaceID string `json:"workspace_id"`
	Label       string `json:"label"`
}

type Tab struct {
	TabID       string `json:"tab_id"`
	WorkspaceID string `json:"workspace_id"`
	Label       string `json:"label"`
}

type Pane struct {
	PaneID     string `json:"pane_id"`
	TabID      string `json:"tab_id"`
	TerminalID string `json:"terminal_id"`
}

type Snapshot struct {
	Workspaces []Workspace `json:"workspaces"`
	Tabs       []Tab       `json:"tabs"`
	Panes      []Pane      `json:"panes"`

	FocusedWorkspaceID string `json:"focused_workspace_id,omitempty"`
	FocusedTabID       string `json:"focused_tab_id,omitempty"`
	FocusedPaneID      string `json:"focused_pane_id,omitempty"`
}

type Envelope struct {
	Result struct {
		Snapshot *Snapshot `json:"snapshot"`
	} `json:"result"`
}

// Face is one entry of the state array the browser consumes. The JSON shape is the
// contract the page already reads; the field tags reproduce it exactly.
type Face struct {
	Face       int    `json:"face"`
	Session    string `json:"session"`
	Workspace  string `json:"workspace"`
	TabID      string `json:"tabId"`
	PaneID     string `json:"paneId"`
	TerminalID string `json:"terminalId"`
	Snapshot   any    `json:"snapshot"`
}

type selected struct {
	face      int
	workspace Workspace
	tab       Tab
	pane      Pane
}

// Client runs the herdr CLI. One at a time per workspace, for the reason spelled out on
// EnsureWorkspace.
type Client struct {
	Executable string

	mu           sync.Mutex
	provisioning map[string]*sync.Mutex
}

func New(executable string) *Client {
	return &Client{Executable: executable, provisioning: map[string]*sync.Mutex{}}
}

// ReadState returns the cube's faces. faceCount < 0 means "however many Face tabs exist",
// floored at facecount.Min so a workspace that has lost a tab still fails closed exactly
// as it always did instead of quietly reporting a smaller cube.
func (client *Client) ReadState(ctx context.Context, workspaceLabel string, faceCount int) ([]Face, error) {
	envelope, raw, err := client.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	return cubeState(envelope, raw, workspaceLabel, faceCount)
}

// EnsureWorkspace makes the cube's tabs idempotently so local and cloud hosts need no
// separate setup ceremony, while leaving every unrelated workspace and tab alone.
//
// It only ever CREATES. Shrinking the cube from ten faces to six stops rendering four
// panes; it must not close them, because someone may have an agent mid-task in Face 9,
// and a tab closed here is that agent's work destroyed with no way back. Growing again
// finds those same tabs and reattaches the same panes.
//
// Runs one at a time per workspace. Reading a snapshot, deciding what is missing and then
// creating it is not atomic, and this has several callers that overlap: ten faces
// attaching at once each ask for a different width, and the container's health sweep
// reconciles on its own timer. Two overlapping runs both see "Face 7 absent" and both
// create it — and SetupPlan then refuses that workspace forever, so the cube is dead until
// a human closes tabs by hand. Measured against a live herdr: widening six faces to ten
// produced "Face 7, Face 7, Face 8, Face 8" and four faces that never opened again.
func (client *Client) EnsureWorkspace(ctx context.Context, workspaceLabel, cwd string, faceCount int) ([]Face, error) {
	client.mu.Lock()
	lock, ok := client.provisioning[workspaceLabel]
	if !ok {
		lock = &sync.Mutex{}
		client.provisioning[workspaceLabel] = lock
	}
	client.mu.Unlock()

	// A failed run must not poison the queue: the caller behind it is usually the sweep
	// that exists to repair exactly that failure. An unlocked mutex is that guarantee.
	lock.Lock()
	defer lock.Unlock()
	return client.provision(ctx, workspaceLabel, cwd, faceCount)
}

func (client *Client) provision(ctx context.Context, workspaceLabel, cwd string, faceCount int) ([]Face, error) {
	count := facecount.ClampDefault(faceCount).Faces
	envelope, raw, err := client.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	plan, err := SetupPlan(envelope, workspaceLabel, count)
	if err != nil {
		return nil, err
	}
	workspaceID := plan.WorkspaceID
	createFaces := plan.CreateFaces

	switch {
	case workspaceID == "":
		created, err := client.run(ctx, "workspace", "create", "--cwd", cwd, "--label", workspaceLabel, "--no-focus")
		if err != nil {
			return nil, err
		}
		var reply struct {
			Result struct {
				Workspace struct {
					WorkspaceID string `json:"workspace_id"`
				} `json:"workspace"`
				Tab struct {
					TabID string `json:"tab_id"`
				} `json:"tab"`
			} `json:"result"`
		}
		if err := json.Unmarshal(created, &reply); err != nil {
			return nil, fmt.Errorf("herdr workspace create returned unreadable JSON: %w", err)
		}
		workspaceID = reply.Result.Workspace.WorkspaceID
		if _, err := client.run(ctx, "tab", "rename", reply.Result.Tab.TabID, "Face 1"); err != nil {
			return nil, err
		}
		createFaces = createFaces[1:]
	case plan.RenameTabID != "":
		if _, err := client.run(ctx, "tab", "rename", plan.RenameTabID, "Face 1"); err != nil {
			return nil, err
		}
		createFaces = createFaces[1:]
	}

	for _, face := range createFaces {
		if _, err := client.run(ctx, "tab", "create", "--workspace", workspaceID, "--cwd", cwd,
			"--label", fmt.Sprintf("Face %d", face), "--no-focus"); err != nil {
			return nil, err
		}
	}

	if plan.WorkspaceID == "" || plan.RenameTabID != "" || len(createFaces) > 0 {
		if envelope, raw, err = client.snapshot(ctx); err != nil {
			return nil, err
		}
	}
	return cubeState(envelope, raw, workspaceLabel, count)
}

type Plan struct {
	WorkspaceID string
	RenameTabID string
	CreateFaces []int
}

// SetupPlan names tabs to create and never tabs to remove — see EnsureWorkspace.
func SetupPlan(envelope *Envelope, workspaceLabel string, faceCount int) (Plan, error) {
	count := facecount.ClampDefault(faceCount).Faces
	snapshot := envelope.snapshot()
	if snapshot == nil {
		return Plan{}, fmt.Errorf("HerdR snapshot is missing")
	}

	workspaces := matchWorkspaces(snapshot, workspaceLabel)
	if len(workspaces) > 1 {
		return Plan{}, fmt.Errorf("expected at most one HerdR workspace named %q; found %d", workspaceLabel, len(workspaces))
	}
	allFaces := make([]int, count)
	for index := range allFaces {
		allFaces[index] = index + 1
	}
	if len(workspaces) == 0 {
		return Plan{CreateFaces: allFaces}, nil
	}

	workspaceID := workspaces[0].WorkspaceID
	tabs := tabsOf(snapshot, workspaceID)
	var createFaces []int
	for _, face := range allFaces {
		matches := labelled(tabs, fmt.Sprintf("Face %d", face))
		if len(matches) > 1 {
			return Plan{}, fmt.Errorf("HerdR workspace %q contains duplicate tabs named \"Face %d\"", workspaceLabel, face)
		}
		if len(matches) == 0 {
			createFaces = append(createFaces, face)
		}
	}

	plan := Plan{WorkspaceID: workspaceID, CreateFaces: createFaces}
	if len(createFaces) == count && len(tabs) == 1 && isDigits(tabs[0].Label) {
		plan.RenameTabID = tabs[0].TabID
	}
	return plan, nil
}

// PaneIDs are the only panes /ping may judge. Every other pane in the Herdr server
// belongs to somebody else's work and must not keep this machine awake.
//
// Scoped to the faces that EXIST, not the faces being rendered. Shrinking the cube hides
// a pane without closing it, and a hidden Face 9 can still hold an agent mid-task; judging
// only the visible faces would sleep the microVM out from under it.
func PaneIDs(envelope *Envelope, workspaceLabel string) ([]string, error) {
	faces, err := SelectFaces(envelope, workspaceLabel, -1)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(faces))
	for index, face := range faces {
		ids[index] = face.pane.PaneID
	}
	return ids, nil
}

// CountFaces reports how many "Face n" tabs the workspace holds, counting up from 1 and
// stopping at the first gap. Capped at the ten-shell ceiling so a stray "Face 11" someone
// made by hand cannot widen the cube past what AgentCore will serve.
func CountFaces(envelope *Envelope, workspaceLabel string) int {
	snapshot := envelope.snapshot()
	if snapshot == nil {
		return 0
	}
	workspaces := matchWorkspaces(snapshot, workspaceLabel)
	if len(workspaces) == 0 {
		return 0
	}
	tabs := tabsOf(snapshot, workspaces[0].WorkspaceID)

	// A face only counts if it is whole. SelectFaces refuses a snapshot over a tab that
	// has lost its pane, and one broken face nobody is even looking at must not take the
	// visible cube down with it — the sweep repairs it on the next pass.
	usable := func(face int) bool {
		matches := labelled(tabs, fmt.Sprintf("Face %d", face))
		if len(matches) != 1 {
			return false
		}
		panes := panesOf(snapshot, matches[0].TabID)
		return len(panes) == 1 && panes[0].TerminalID != ""
	}
	count := 0
	for count < facecount.Max && usable(count+1) {
		count++
	}
	return count
}

// SelectFaces resolves the cube's faces. faceCount < 0 means "however many exist".
func SelectFaces(envelope *Envelope, workspaceLabel string, faceCount int) ([]selected, error) {
	snapshot := envelope.snapshot()
	if snapshot == nil {
		return nil, fmt.Errorf("HerdR snapshot is missing")
	}

	workspaces := matchWorkspaces(snapshot, workspaceLabel)
	if len(workspaces) != 1 {
		return nil, fmt.Errorf("expected exactly one HerdR workspace named %q; found %d", workspaceLabel, len(workspaces))
	}
	workspace := workspaces[0]
	workspaceTabs := tabsOf(snapshot, workspace.WorkspaceID)

	// More tabs than were asked for is not an error — that is what a shrunken cube looks
	// like, and the surplus is somebody's live work. Fewer still is: the floor keeps a
	// workspace that has lost a tab failing closed so reconciliation repairs it.
	count := faceCount
	if count < 0 {
		count = max(facecount.Min, CountFaces(envelope, workspaceLabel))
	} else {
		count = facecount.ClampDefault(count).Faces
	}

	faces := make([]selected, 0, count)
	for face := range count {
		label := fmt.Sprintf("Face %d", face+1)
		tabs := labelled(workspaceTabs, label)
		if len(tabs) != 1 {
			return nil, fmt.Errorf("HerdR workspace %q must contain exactly one tab named %q", workspaceLabel, label)
		}
		panes := panesOf(snapshot, tabs[0].TabID)
		if len(panes) != 1 || panes[0].TerminalID == "" {
			return nil, fmt.Errorf("tab %q must contain exactly one terminal pane", tabs[0].Label)
		}
		faces = append(faces, selected{face: face, workspace: workspace, tab: tabs[0], pane: panes[0]})
	}
	return faces, nil
}

// cubeState carries the raw snapshot bytes through so each face can republish the whole
// envelope with its own focus fields set, exactly as the JS did. Re-marshalling a parsed
// struct would drop every field this port does not model, and the browser reads some of
// them.
func cubeState(envelope *Envelope, raw []byte, workspaceLabel string, faceCount int) ([]Face, error) {
	selection, err := SelectFaces(envelope, workspaceLabel, faceCount)
	if err != nil {
		return nil, err
	}
	state := make([]Face, 0, len(selection))
	for _, item := range selection {
		focused, err := withFocus(raw, item)
		if err != nil {
			return nil, err
		}
		state = append(state, Face{
			Face:       item.face,
			Session:    "default",
			Workspace:  item.workspace.Label,
			TabID:      item.tab.TabID,
			PaneID:     item.pane.PaneID,
			TerminalID: item.pane.TerminalID,
			Snapshot:   focused,
		})
	}
	return state, nil
}

// withFocus rewrites only the three focus fields, leaving every other key of the original
// envelope byte-identical.
func withFocus(raw []byte, item selected) (any, error) {
	var envelope map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	result, _ := envelope["result"].(map[string]any)
	if result == nil {
		return envelope, nil
	}
	snapshot, _ := result["snapshot"].(map[string]any)
	if snapshot == nil {
		return envelope, nil
	}
	snapshot["focused_workspace_id"] = item.workspace.WorkspaceID
	snapshot["focused_tab_id"] = item.tab.TabID
	snapshot["focused_pane_id"] = item.pane.PaneID
	return envelope, nil
}

func (envelope *Envelope) snapshot() *Snapshot {
	if envelope == nil {
		return nil
	}
	return envelope.Result.Snapshot
}

func matchWorkspaces(snapshot *Snapshot, label string) []Workspace {
	var matches []Workspace
	for _, workspace := range snapshot.Workspaces {
		if workspace.Label == label {
			matches = append(matches, workspace)
		}
	}
	return matches
}

func tabsOf(snapshot *Snapshot, workspaceID string) []Tab {
	var tabs []Tab
	for _, tab := range snapshot.Tabs {
		if tab.WorkspaceID == workspaceID {
			tabs = append(tabs, tab)
		}
	}
	return tabs
}

func panesOf(snapshot *Snapshot, tabID string) []Pane {
	var panes []Pane
	for _, pane := range snapshot.Panes {
		if pane.TabID == tabID {
			panes = append(panes, pane)
		}
	}
	return panes
}

func labelled(tabs []Tab, label string) []Tab {
	var matches []Tab
	for _, tab := range tabs {
		if tab.Label == label {
			matches = append(matches, tab)
		}
	}
	return matches
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	return strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) < 0
}

func (client *Client) snapshot(ctx context.Context) (*Envelope, []byte, error) {
	raw, err := client.run(ctx, "api", "snapshot")
	if err != nil {
		return nil, nil, err
	}
	var envelope Envelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, nil, fmt.Errorf("herdr api snapshot returned unreadable JSON: %w", err)
	}
	return &envelope, raw, nil
}

func (client *Client) run(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, client.Executable, append([]string{"--session", "default"}, args...)...)
	var stdout, stderr strings.Builder
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("herdr %s: %s", strings.Join(args, " "), detail)
	}
	return []byte(stdout.String()), nil
}
