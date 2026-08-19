package herdr

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// snapshotJSON builds a herdr `api snapshot` envelope with faceCount whole faces.
func snapshotJSON(t *testing.T, label string, faceCount int, extra string) ([]byte, *Envelope) {
	t.Helper()
	var tabs, panes []string
	for face := 1; face <= faceCount; face++ {
		tabs = append(tabs, fmt.Sprintf(`{"tab_id":"tab%d","workspace_id":"ws1","label":"Face %d"}`, face, face))
		panes = append(panes, fmt.Sprintf(`{"pane_id":"pane%d","tab_id":"tab%d","terminal_id":"term%d"}`, face, face, face))
	}
	if extra != "" {
		tabs = append(tabs, extra)
	}
	raw := fmt.Sprintf(
		`{"result":{"snapshot":{"workspaces":[{"workspace_id":"ws1","label":%q}],"tabs":[%s],"panes":[%s],"extra_field":"kept"}}}`,
		label, strings.Join(tabs, ","), strings.Join(panes, ","))

	var envelope Envelope
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		t.Fatalf("building snapshot: %v", err)
	}
	return []byte(raw), &envelope
}

func TestSetupPlanCreatesEveryFaceWhenTheWorkspaceIsMissing(t *testing.T) {
	_, envelope := snapshotJSON(t, "Somebody Else", 6, "")
	plan, err := SetupPlan(envelope, DefaultWorkspace, 6)
	if err != nil {
		t.Fatalf("SetupPlan: %v", err)
	}
	if plan.WorkspaceID != "" || len(plan.CreateFaces) != 6 {
		t.Fatalf("plan = %+v, want an empty workspace and six faces to create", plan)
	}
}

func TestSetupPlanCreatesOnlyTheMissingFaces(t *testing.T) {
	_, envelope := snapshotJSON(t, DefaultWorkspace, 6, "")
	plan, err := SetupPlan(envelope, DefaultWorkspace, 10)
	if err != nil {
		t.Fatalf("SetupPlan: %v", err)
	}
	want := []int{7, 8, 9, 10}
	if plan.WorkspaceID != "ws1" || fmt.Sprint(plan.CreateFaces) != fmt.Sprint(want) {
		t.Fatalf("plan = %+v, want faces %v on ws1", plan, want)
	}
}

// The plan names tabs to create and never tabs to remove: shrinking the cube must not
// close a tab that may hold an agent mid-task.
func TestSetupPlanNeverRemovesSurplusFaces(t *testing.T) {
	_, envelope := snapshotJSON(t, DefaultWorkspace, 10, "")
	plan, err := SetupPlan(envelope, DefaultWorkspace, 6)
	if err != nil {
		t.Fatalf("SetupPlan: %v", err)
	}
	if len(plan.CreateFaces) != 0 {
		t.Fatalf("plan = %+v, want nothing to do", plan)
	}
}

func TestSetupPlanRefusesDuplicateFaceTabs(t *testing.T) {
	duplicate := `{"tab_id":"tabX","workspace_id":"ws1","label":"Face 2"}`
	_, envelope := snapshotJSON(t, DefaultWorkspace, 6, duplicate)
	if _, err := SetupPlan(envelope, DefaultWorkspace, 6); err == nil ||
		!strings.Contains(err.Error(), "duplicate tabs") {
		t.Fatalf("err = %v, want a duplicate-tab refusal", err)
	}
}

// A fresh `herdr workspace create` leaves one numerically-labelled tab; that is the seed
// to rename rather than a seventh face to create.
func TestSetupPlanRenamesTheSeedTab(t *testing.T) {
	raw := `{"result":{"snapshot":{"workspaces":[{"workspace_id":"ws1","label":"Coding Cube"}],` +
		`"tabs":[{"tab_id":"seed","workspace_id":"ws1","label":"1"}],"panes":[]}}}`
	var envelope Envelope
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		t.Fatal(err)
	}
	plan, err := SetupPlan(&envelope, DefaultWorkspace, 6)
	if err != nil {
		t.Fatalf("SetupPlan: %v", err)
	}
	if plan.RenameTabID != "seed" || len(plan.CreateFaces) != 6 {
		t.Fatalf("plan = %+v, want seed renamed and six faces planned", plan)
	}
}

func TestCountFacesStopsAtTheFirstGap(t *testing.T) {
	// Faces 1..3 whole, then a jump to Face 5: the cube is three faces wide.
	raw := `{"result":{"snapshot":{"workspaces":[{"workspace_id":"ws1","label":"Coding Cube"}],"tabs":[` +
		`{"tab_id":"t1","workspace_id":"ws1","label":"Face 1"},` +
		`{"tab_id":"t2","workspace_id":"ws1","label":"Face 2"},` +
		`{"tab_id":"t3","workspace_id":"ws1","label":"Face 3"},` +
		`{"tab_id":"t5","workspace_id":"ws1","label":"Face 5"}],"panes":[` +
		`{"pane_id":"p1","tab_id":"t1","terminal_id":"x1"},` +
		`{"pane_id":"p2","tab_id":"t2","terminal_id":"x2"},` +
		`{"pane_id":"p3","tab_id":"t3","terminal_id":"x3"},` +
		`{"pane_id":"p5","tab_id":"t5","terminal_id":"x5"}]}}}`
	var envelope Envelope
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		t.Fatal(err)
	}
	if got := CountFaces(&envelope, DefaultWorkspace); got != 3 {
		t.Fatalf("CountFaces = %d, want 3", got)
	}
}

// A tab that has lost its pane is not a usable face, and must not be counted.
func TestCountFacesIgnoresAFaceWithNoPane(t *testing.T) {
	raw := `{"result":{"snapshot":{"workspaces":[{"workspace_id":"ws1","label":"Coding Cube"}],"tabs":[` +
		`{"tab_id":"t1","workspace_id":"ws1","label":"Face 1"},` +
		`{"tab_id":"t2","workspace_id":"ws1","label":"Face 2"}],"panes":[` +
		`{"pane_id":"p1","tab_id":"t1","terminal_id":"x1"}]}}}`
	var envelope Envelope
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		t.Fatal(err)
	}
	if got := CountFaces(&envelope, DefaultWorkspace); got != 1 {
		t.Fatalf("CountFaces = %d, want 1", got)
	}
}

func TestSelectFacesFloorsAtTheMinimum(t *testing.T) {
	// Only three whole faces exist, but asking for "however many" still fails closed at
	// the six-face floor so reconciliation repairs the workspace.
	_, envelope := snapshotJSON(t, DefaultWorkspace, 3, "")
	if _, err := SelectFaces(envelope, DefaultWorkspace, -1); err == nil ||
		!strings.Contains(err.Error(), "exactly one tab named \"Face 4\"") {
		t.Fatalf("err = %v, want a refusal naming Face 4", err)
	}
}

// cubeState must republish the ORIGINAL envelope with focus set, keeping fields this port
// does not model. Losing them would silently change what the browser receives.
func TestCubeStatePreservesUnmodelledSnapshotFields(t *testing.T) {
	raw, envelope := snapshotJSON(t, DefaultWorkspace, 6, "")
	state, err := cubeState(envelope, raw, DefaultWorkspace, 6)
	if err != nil {
		t.Fatalf("cubeState: %v", err)
	}
	if len(state) != 6 {
		t.Fatalf("got %d faces, want 6", len(state))
	}

	encoded, err := json.Marshal(state[2])
	if err != nil {
		t.Fatal(err)
	}
	var face map[string]any
	if err := json.Unmarshal(encoded, &face); err != nil {
		t.Fatal(err)
	}
	if face["terminalId"] != "term3" || face["face"].(float64) != 2 || face["session"] != "default" {
		t.Fatalf("face 2 = %v", face)
	}

	snapshot := face["snapshot"].(map[string]any)["result"].(map[string]any)["snapshot"].(map[string]any)
	if snapshot["extra_field"] != "kept" {
		t.Fatal("an unmodelled snapshot field was dropped")
	}
	if snapshot["focused_tab_id"] != "tab3" || snapshot["focused_pane_id"] != "pane3" {
		t.Fatalf("focus not applied: %v", snapshot)
	}
}

func TestPaneIDsCoverEveryExistingFace(t *testing.T) {
	// Ten faces exist even though six may be rendered; /ping must judge all ten.
	_, envelope := snapshotJSON(t, DefaultWorkspace, 10, "")
	ids, err := PaneIDs(envelope, DefaultWorkspace)
	if err != nil {
		t.Fatalf("PaneIDs: %v", err)
	}
	if len(ids) != 10 || ids[9] != "pane10" {
		t.Fatalf("ids = %v", ids)
	}
}
