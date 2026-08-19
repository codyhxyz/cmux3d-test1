package gateway

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/codyhxyz/coding-cube/go/internal/originauth"
	"github.com/codyhxyz/coding-cube/go/internal/terminal"
)

const testToken = "test-token-abcdefghijklmnop"

func newServer(t *testing.T, configure func(*Server)) (*Server, *httptest.Server) {
	t.Helper()
	public := t.TempDir()
	if err := os.WriteFile(filepath.Join(public, "index.html"), []byte("<h1>cube</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	grid, err := terminal.NewGrid(terminal.Options{Cwd: t.TempDir(), Shell: "/bin/sh"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(grid.CloseAll)

	server := &Server{
		PublicRoot: public,
		WebOrigin:  "https://codingcube.codyh.xyz",
		Token:      testToken,
		Exposure:   &originauth.Exposure{},
		Grid:       grid,
	}
	if configure != nil {
		configure(server)
	}
	httpServer := httptest.NewServer(server)
	t.Cleanup(httpServer.Close)
	return server, httpServer
}

func get(t *testing.T, base, path string, header map[string]string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range header {
		req.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response, string(body)
}

func TestHealthIsOpenToALocalCaller(t *testing.T) {
	_, httpServer := newServer(t, nil)
	response, body := get(t, httpServer.URL, "/health", nil)
	if response.StatusCode != http.StatusOK || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("status %d body %q", response.StatusCode, body)
	}
}

// The shell is public code, and a phone opening a `#token=` link cannot present the
// fragment on its document request. Only capability routes require pairing.
func TestTheIndexPageNeedsNoPairing(t *testing.T) {
	_, httpServer := newServer(t, nil)
	response, body := get(t, httpServer.URL, "/", nil)
	if response.StatusCode != http.StatusOK || !strings.Contains(body, "cube") {
		t.Fatalf("status %d body %q", response.StatusCode, body)
	}
	if got := response.Header.Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
}

func TestHostedOriginNeedsTheCodeForCapabilityRoutes(t *testing.T) {
	_, httpServer := newServer(t, nil)
	hosted := map[string]string{"Origin": "https://codingcube.codyh.xyz"}

	response, _ := get(t, httpServer.URL, "/health", hosted)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.StatusCode)
	}

	response, _ = get(t, httpServer.URL, "/health?token="+testToken, hosted)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 with the code", response.StatusCode)
	}
}

func TestAStrangerOriginIsRefused(t *testing.T) {
	_, httpServer := newServer(t, nil)
	response, body := get(t, httpServer.URL, "/health", map[string]string{"Origin": "https://evil.example"})
	if response.StatusCode != http.StatusForbidden || !strings.Contains(body, "origin not allowed") {
		t.Fatalf("status %d body %q", response.StatusCode, body)
	}
}

// The pairing code only leaves the machine for the QR, and only once the cube is exposed.
func TestHostInfoWithholdsTheCodeUntilExposed(t *testing.T) {
	server, httpServer := newServer(t, nil)

	_, body := get(t, httpServer.URL, "/api/host/info", nil)
	var info map[string]any
	if err := json.Unmarshal([]byte(body), &info); err != nil {
		t.Fatal(err)
	}
	if info["token"] != nil || info["exposed"] != false {
		t.Fatalf("info = %v, want no token while unexposed", info)
	}

	server.Exposure.Active = true
	_, body = get(t, httpServer.URL, "/api/host/info", nil)
	if err := json.Unmarshal([]byte(body), &info); err != nil {
		t.Fatal(err)
	}
	if info["token"] != testToken {
		t.Fatalf("info = %v, want the token once exposed", info)
	}
}

func TestPathTraversalIsRefused(t *testing.T) {
	_, httpServer := newServer(t, nil)
	// The Go client normalizes ../ in a URL, so the encoded form is what actually reaches
	// a handler from a hostile caller.
	response, _ := get(t, httpServer.URL, "/..%2f..%2f..%2fetc%2fpasswd", nil)
	if response.StatusCode == http.StatusOK {
		t.Fatal("traversal returned a file")
	}
}

func TestGatewayOnlyServesNoStaticFiles(t *testing.T) {
	_, httpServer := newServer(t, func(server *Server) { server.GatewayOnly = true })

	response, body := get(t, httpServer.URL, "/", nil)
	if response.StatusCode != http.StatusNotFound || !strings.Contains(body, "terminal gateway") {
		t.Fatalf("status %d body %q", response.StatusCode, body)
	}
	// The capability routes still answer: gateway-only removes the page, not the API.
	if response, _ := get(t, httpServer.URL, "/health", nil); response.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d, want 200", response.StatusCode)
	}
}

func TestHerdrRoutesDegradeWhenHerdrIsOff(t *testing.T) {
	_, httpServer := newServer(t, nil)

	response, body := get(t, httpServer.URL, "/api/herdr/state", nil)
	if response.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, "Herdr is disabled") {
		t.Fatalf("status %d body %q", response.StatusCode, body)
	}
	// Failures degrade, they do not interrupt: an absent event stream is 204, not an error.
	if response, _ := get(t, httpServer.URL, "/api/herdr/events", nil); response.StatusCode != http.StatusNoContent {
		t.Fatalf("events status = %d, want 204", response.StatusCode)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	_, httpServer := newServer(t, nil)
	response, err := http.Post(httpServer.URL+"/health", "text/plain", strings.NewReader("x"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", response.StatusCode)
	}
}

func dialWS(t *testing.T, base, path string, header http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	url := "ws" + strings.TrimPrefix(base, "http") + path
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header})
}

func TestTerminalSocketRunsAShell(t *testing.T) {
	_, httpServer := newServer(t, nil)
	conn, _, err := dialWS(t, httpServer.URL, "/ws/pty?face=0&slot=0", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte("echo socket-works\n")); err != nil {
		t.Fatal(err)
	}

	var seen strings.Builder
	for !strings.Contains(seen.String(), "socket-works") {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (saw %q)", err, seen.String())
		}
		seen.Write(data)
	}
}

func TestTerminalSocketAcceptsAResizeFrame(t *testing.T) {
	_, httpServer := newServer(t, nil)
	conn, _, err := dialWS(t, httpServer.URL, "/ws/pty?face=1&slot=0", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resize := make([]byte, 8)
	copy(resize, []byte("CUBE"))
	binary.BigEndian.PutUint16(resize[4:6], 100)
	binary.BigEndian.PutUint16(resize[6:8], 40)
	if err := conn.Write(ctx, websocket.MessageBinary, resize); err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte("tput cols\n")); err != nil {
		t.Fatal(err)
	}

	var seen strings.Builder
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		seen.Write(data)
		if strings.Contains(seen.String(), "100") {
			return
		}
	}
	t.Fatalf("the resize did not take effect; saw %q", seen.String())
}

func TestTerminalSocketRefusesAStrangerOrigin(t *testing.T) {
	_, httpServer := newServer(t, nil)
	header := http.Header{"Origin": []string{"https://evil.example"}}
	conn, response, err := dialWS(t, httpServer.URL, "/ws/pty?face=0", header)
	if err == nil {
		conn.Close(websocket.StatusNormalClosure, "")
		t.Fatal("a stranger origin completed the upgrade")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("response = %v, want 403", response)
	}
}

func TestTerminalSocketRefusesTheHostedOriginWithoutTheCode(t *testing.T) {
	_, httpServer := newServer(t, nil)
	header := http.Header{"Origin": []string{"https://codingcube.codyh.xyz"}}
	conn, response, err := dialWS(t, httpServer.URL, "/ws/pty?face=0", header)
	if err == nil {
		conn.Close(websocket.StatusNormalClosure, "")
		t.Fatal("the hosted origin connected without a pairing code")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("response = %v, want 401", response)
	}

	// With the code it connects.
	conn, _, err = dialWS(t, httpServer.URL, "/ws/pty?face=0&token="+testToken, header)
	if err != nil {
		t.Fatalf("dial with the code: %v", err)
	}
	conn.Close(websocket.StatusNormalClosure, "")
}

func TestUnknownWebsocketPathIs404(t *testing.T) {
	_, httpServer := newServer(t, nil)
	conn, response, err := dialWS(t, httpServer.URL, "/ws/nope", nil)
	if err == nil {
		conn.Close(websocket.StatusNormalClosure, "")
		t.Fatal("an unknown path completed the upgrade")
	}
	if response == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("response = %v, want 404", response)
	}
}

// The /ws path is the AgentCore passthrough, where the face arrives in a hello frame
// rather than the query string.
func TestHelloFrameNamesTheFace(t *testing.T) {
	server, httpServer := newServer(t, nil)
	conn, _, err := dialWS(t, httpServer.URL, "/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"face":2,"slot":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte("echo hello-face\n")); err != nil {
		t.Fatal(err)
	}

	var seen strings.Builder
	for !strings.Contains(seen.String(), "hello-face") {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (saw %q)", err, seen.String())
		}
		seen.Write(data)
	}
	_ = server
}

// A client that never says hello still gets a shell, and the input it sent first is
// replayed rather than dropped.
func TestNonHelloFramesAreReplayedAfterTheTimeout(t *testing.T) {
	_, httpServer := newServer(t, nil)
	conn, _, err := dialWS(t, httpServer.URL, "/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Eight non-hello frames trip the frame bound immediately, so the test does not wait
	// out the ten-second hello timeout.
	for range helloFrameLimit {
		if err := conn.Write(ctx, websocket.MessageText, []byte("echo replayed\n")); err != nil {
			t.Fatal(err)
		}
	}

	var seen strings.Builder
	for !strings.Contains(seen.String(), "replayed") {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (saw %q)", err, seen.String())
		}
		seen.Write(data)
	}
}
