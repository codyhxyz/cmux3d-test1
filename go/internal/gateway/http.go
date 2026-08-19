package gateway

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/codyhxyz/coding-cube/go/internal/originauth"
	"github.com/codyhxyz/coding-cube/go/internal/terminal"
)

// Server is the whole gateway: static assets, the API, and the terminal sockets.
type Server struct {
	PublicRoot  string
	VendorFiles map[string]string
	WebOrigin   string
	Token       string
	Exposure    *originauth.Exposure
	Tailnet     originauth.Identity
	GatewayOnly bool
	Grid        *terminal.Grid
}

var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".wasm":        "application/wasm",
	".task":        "application/octet-stream",
	".svg":         "image/svg+xml; charset=utf-8",
	".png":         "image/png",
	".ico":         "image/x-icon",
	".txt":         "text/plain; charset=utf-8",
	".sh":          "text/x-shellscript; charset=utf-8",
}

func (server *Server) authOptions() originauth.Options {
	return originauth.Options{
		WebOrigin: server.WebOrigin,
		Token:     server.Token,
		Exposure:  server.Exposure,
		Tailnet:   server.Tailnet,
	}
}

// needsPairing gates the capability routes only. The shell is public code, and a phone
// opening a `#token=` link cannot present the fragment on its document request.
func needsPairing(pathname string) bool {
	return pathname == "/health" || strings.HasPrefix(pathname, "/api/")
}

func (server *Server) ServeHTTP(writer http.ResponseWriter, req *http.Request) {
	requestURL := req.URL
	if requestURL.Path == "" {
		requestURL = &url.URL{Path: "/"}
	}

	// Terminal sockets carry their own origin and pairing checks, because a failed
	// upgrade has to answer with a status line rather than a CORS header.
	if req.Header.Get("Upgrade") != "" && strings.EqualFold(req.Header.Get("Upgrade"), "websocket") {
		if server.ServeWS(writer, req, requestURL) {
			return
		}
		http.Error(writer, "not found", http.StatusNotFound)
		return
	}

	corsAllowed := originauth.AllowCORS(req, writer.Header(), server.WebOrigin, server.Exposure)
	if req.Header.Get("Origin") != "" && !corsAllowed {
		sendText(writer, http.StatusForbidden, "origin not allowed")
		return
	}
	if req.Method == http.MethodOptions {
		writer.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		sendText(writer, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if needsPairing(requestURL.Path) && !originauth.RequestAuthorized(req, requestURL, server.authOptions()) {
		sendText(writer, http.StatusUnauthorized, "pairing required")
		return
	}

	switch requestURL.Path {
	case "/health":
		sendJSON(writer, http.StatusOK, map[string]any{"ok": true, "service": "coding-cube"})
		return
	case "/api/host/info":
		server.hostInfo(writer, req, requestURL)
		return
	case "/api/herdr/state":
		server.herdrState(writer, req)
		return
	case "/api/herdr/events":
		server.herdrEvents(writer, req)
		return
	}

	if server.GatewayOnly {
		sendText(writer, http.StatusNotFound, "terminal gateway")
		return
	}
	server.serveFile(writer, req, requestURL)
}

func (server *Server) hostInfo(writer http.ResponseWriter, req *http.Request, requestURL *url.URL) {
	writer.Header().Set("Cache-Control", "no-store")
	exposed := server.Exposure != nil && server.Exposure.Active
	tsOrigin := ""
	if server.Exposure != nil {
		tsOrigin = server.Exposure.TSOrigin
	}
	// The pairing code only leaves the machine for the QR, and only to a caller that is
	// same-origin or has already proved it holds the code.
	var token *string
	if exposed && originauth.TrustedForSecrets(req, requestURL, server.Token) {
		token = &server.Token
	}
	var origin *string
	if tsOrigin != "" {
		origin = &tsOrigin
	}
	// A struct rather than a map, so the key order matches the Node server's byte for
	// byte: encoding/json sorts map keys, and a diff there is noise every time the two
	// implementations are compared.
	sendJSON(writer, http.StatusOK, struct {
		Service   string  `json:"service"`
		WebOrigin string  `json:"webOrigin"`
		Exposed   bool    `json:"exposed"`
		TSOrigin  *string `json:"tsOrigin"`
		Token     *string `json:"token"`
	}{"coding-cube", server.WebOrigin, exposed, origin, token})
}

func (server *Server) herdrState(writer http.ResponseWriter, req *http.Request) {
	if !server.Grid.UsesHerdr() {
		sendJSON(writer, http.StatusServiceUnavailable, map[string]any{"error": "Herdr is disabled"})
		return
	}
	state, err := server.Grid.Herdr().ReadState(req.Context(), server.Grid.Workspace(), -1)
	if err != nil {
		sendJSON(writer, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	// Publishing the targets here matches the JS readState wrapper: the state read is
	// also how the grid learns which terminal each face maps to.
	ids := make([]string, len(state))
	for index, face := range state {
		ids[index] = face.TerminalID
	}
	server.Grid.SetTargets(ids)
	sendJSON(writer, http.StatusOK, state)
}

func (server *Server) herdrEvents(writer http.ResponseWriter, req *http.Request) {
	if !server.Grid.UsesHerdr() {
		writer.WriteHeader(http.StatusNoContent)
		return
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writer.WriteHeader(http.StatusNoContent)
		return
	}

	header := writer.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	writer.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := req.Context()
	var mu sync.Mutex
	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }

	send := func(line string) {
		mu.Lock()
		defer mu.Unlock()
		select {
		case <-done:
			return
		default:
		}
		if _, err := writer.Write([]byte(line)); err != nil {
			finish()
			return
		}
		flusher.Flush()
	}

	stop, err := server.Grid.Herdr().Watch(ctx, server.Grid.Workspace(),
		func() { send("data: change\n\n") },
		finish,
		nil,
	)
	if err != nil {
		return
	}
	defer stop()

	send("data: ready\n\n")

	// Proxies (tailscale serve among them) drop idle streams; a comment keeps it warm.
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-heartbeat.C:
			send(":hb\n\n")
		case <-done:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (server *Server) serveFile(writer http.ResponseWriter, req *http.Request, requestURL *url.URL) {
	pathname := requestURL.Path
	if pathname == "/" {
		pathname = "/index.html"
	}

	filePath, vendored := server.VendorFiles[pathname]
	if !vendored {
		// Join before cleaning, never after: cleaning "/../../etc/passwd" on its own would
		// yield "/etc/passwd", which then joins *inside* the root and turns an escape
		// attempt into an ordinary miss. Joining first keeps the ../ segments where the
		// containment check below can see them, so a traversal is refused rather than
		// quietly rewritten — the same 403 the Node server answers.
		filePath = filepath.Join(server.PublicRoot, filepath.FromSlash(pathname))
		if !isInside(server.PublicRoot, filePath) {
			sendText(writer, http.StatusForbidden, "forbidden")
			return
		}
	}

	contentType, ok := contentTypes[strings.ToLower(filepath.Ext(filePath))]
	if !ok {
		contentType = "application/octet-stream"
	}
	writer.Header().Set("Content-Type", contentType)
	writer.Header().Set("Cache-Control", "no-store")

	file, err := openRegular(filePath)
	if err != nil {
		// Reset the headers set above so a 404 does not claim a content type it has no
		// body for.
		writer.Header().Del("Content-Type")
		sendText(writer, http.StatusNotFound, "not found")
		return
	}
	defer file.Close()

	if req.Method == http.MethodHead {
		writer.WriteHeader(http.StatusOK)
		return
	}
	http.ServeContent(writer, req, filePath, time.Time{}, file)
}

func isInside(root, filePath string) bool {
	relative, err := filepath.Rel(root, filePath)
	if err != nil {
		return false
	}
	return relative == "." || (!strings.HasPrefix(relative, ".."+string(filepath.Separator)) && relative != "..")
}

func sendText(writer http.ResponseWriter, status int, text string) {
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.WriteHeader(status)
	_, _ = writer.Write([]byte(text))
}

func sendJSON(writer http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		sendText(writer, http.StatusInternalServerError, "encoding failed")
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}

// VendorAssets mirrors src/vendor-assets.js: the browser modules served out of
// node_modules rather than public/.
func VendorAssets(moduleRoot string) map[string]string {
	assets := map[string]string{
		"/vendor/xterm.css":                   "@xterm/xterm/css/xterm.css",
		"/vendor/xterm.mjs":                   "@xterm/xterm/lib/xterm.mjs",
		"/vendor/addon-attach.mjs":            "@xterm/addon-attach/lib/addon-attach.mjs",
		"/vendor/addon-fit.mjs":               "@xterm/addon-fit/lib/addon-fit.mjs",
		"/vendor/addon-webgl.mjs":             "@xterm/addon-webgl/lib/addon-webgl.mjs",
		"/vendor/qrcode.mjs":                  "qrcode-generator/dist/qrcode.mjs",
		"/vendor/mediapipe/vision_bundle.mjs": "@mediapipe/tasks-vision/vision_bundle.mjs",
	}
	for _, variant := range []string{"internal", "module_internal", "nosimd_internal"} {
		for _, extension := range []string{"js", "wasm"} {
			file := "vision_wasm_" + variant + "." + extension
			assets["/vendor/mediapipe/wasm/"+file] = "@mediapipe/tasks-vision/wasm/" + file
		}
	}
	resolved := make(map[string]string, len(assets))
	for route, source := range assets {
		resolved[route] = filepath.Join(moduleRoot, filepath.FromSlash(source))
	}
	return resolved
}

// openRegular refuses directories, so a request for a path that happens to name one
// answers 404 rather than a directory listing.
func openRegular(filePath string) (*os.File, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		file.Close()
		if err == nil {
			err = os.ErrNotExist
		}
		return nil, err
	}
	return file, nil
}
