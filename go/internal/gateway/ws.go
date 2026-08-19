// Package gateway is the Go port of src/server/ws-router.js, static.js and runtime.js.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/codyhxyz/coding-cube/go/internal/originauth"
)

// /ws is the mount path AgentCore's WebSocket passthrough proxies to; /ws/pty is the
// cube's own path and keeps behaving exactly as it always has.
var terminalPaths = map[string]bool{"/ws/pty": true, "/ws": true}

const (
	helloTimeout    = 10 * time.Second
	helloFrameLimit = 8
	// waitForHello bounded its pending buffer at 8 frames, which was 8 x maxPayload of
	// memory — the frame count was never the resource being spent. Bound the bytes as
	// well. 64 KiB is one full SHELL_FRAME_MAX paste arriving before the hello, which is
	// already more than the protocol expects.
	helloByteLimit = 64 * 1024

	// Nothing this socket carries is large: the browser sends keystrokes, 8-byte resize
	// frames, and pastes that transport.js already chunks at SHELL_FRAME_MAX = 64 KiB
	// (32 KiB on the passthrough path). 1 MiB is 16x the largest frame the real client
	// can produce, so no ordinary local or Tailscale terminal session can reach it, while
	// a hostile one is capped well below anything that would matter.
	maxPayload = 1024 * 1024

	// Per-client output buffer. A client that falls this far behind is dropped rather
	// than allowed to stall the PTY for everyone else watching the same face.
	sendQueueDepth = 256
)

// ServeWS handles a terminal websocket. It returns false when the path is not a terminal
// path, leaving the caller to answer 404.
func (server *Server) ServeWS(writer http.ResponseWriter, req *http.Request, requestURL *url.URL) bool {
	if !terminalPaths[requestURL.Path] {
		return false
	}

	allowed := originauth.BrowserOriginAllowed(req.Header.Get("Origin"), originauth.OriginOptions{
		WebOrigin:   server.WebOrigin,
		Exposure:    server.Exposure,
		RequestHost: req.Host,
		Remote:      originauth.RequestIsRemote(req),
	})
	if !allowed {
		http.Error(writer, "origin not allowed", http.StatusForbidden)
		return true
	}
	if !originauth.RequestAuthorized(req, requestURL, server.authOptions()) {
		http.Error(writer, "pairing required", http.StatusUnauthorized)
		return true
	}

	// The origin check above is ours and stricter than the library's, which only knows
	// about same-host requests and would reject the hosted page outright.
	conn, err := websocket.Accept(writer, req, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return true
	}
	conn.SetReadLimit(maxPayload)

	ctx := req.Context()
	client := newClient(ctx, conn)
	defer client.stop()

	face, hasFace := routeValue(req, requestURL, "face")
	slot, _ := routeValue(req, requestURL, "slot")

	var pending [][2]any
	if requestURL.Path != "/ws/pty" && !hasFace {
		// Only X-Amzn-Bedrock-AgentCore-Runtime-Custom-* params are documented to survive
		// the passthrough proxy, so a client that cannot set them names its face in a
		// first text frame instead.
		hello, buffered := waitForHello(ctx, conn)
		pending = buffered
		if hello != nil {
			face, slot = hello.Face, hello.Slot
		}
	}

	reader := replayReader(ctx, conn, pending)
	if err := server.Grid.Attach(ctx, face, slot, client, reader); err != nil {
		log.Printf("terminal attach failed: %v", err)
		_ = client.SendText([]byte("\r\n\x1b[31m" + err.Error() + "\x1b[0m\r\n"))
		client.Close(1011, "terminal attach failed")
	}
	return true
}

// replayReader hands back the frames buffered while waiting for a hello before reading any
// new ones, so input typed before the face was known is delivered rather than dropped.
func replayReader(ctx context.Context, conn *websocket.Conn, pending [][2]any) func() (bool, []byte, error) {
	return func() (bool, []byte, error) {
		if len(pending) > 0 {
			frame := pending[0]
			pending = pending[1:]
			return frame[0].(bool), frame[1].([]byte), nil
		}
		kind, data, err := conn.Read(ctx)
		if err != nil {
			return false, nil, err
		}
		return kind == websocket.MessageText, data, nil
	}
}

type hello struct {
	Face int
	Slot int
}

type helloFrame struct {
	Face *int `json:"face"`
	Slot *int `json:"slot"`
}

// waitForHello reads until a hello arrives or a bound gives out. Either bound giving out
// means the same thing: this client is not going to say hello. Attach it to the default
// face and replay what it has sent.
func waitForHello(ctx context.Context, conn *websocket.Conn) (*hello, [][2]any) {
	ctx, cancel := context.WithTimeout(ctx, helloTimeout)
	defer cancel()

	var pending [][2]any
	bytes := 0
	for len(pending) < helloFrameLimit && bytes < helloByteLimit {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			return nil, pending
		}
		if kind == websocket.MessageText {
			if parsed := parseHello(data); parsed != nil {
				return parsed, pending
			}
		}
		pending = append(pending, [2]any{kind == websocket.MessageText, data})
		bytes += len(data)
	}
	return nil, pending
}

func parseHello(data []byte) *hello {
	var frame helloFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		// Not a hello frame; it is stdin for whichever face the defaults pick.
		return nil
	}
	if frame.Face == nil && frame.Slot == nil {
		return nil
	}
	parsed := &hello{}
	if frame.Face != nil {
		parsed.Face = *frame.Face
	}
	if frame.Slot != nil {
		parsed.Slot = *frame.Slot
	}
	return parsed
}

func routeValue(req *http.Request, requestURL *url.URL, name string) (int, bool) {
	custom := "X-Amzn-Bedrock-AgentCore-Runtime-Custom-" + strings.ToUpper(name[:1]) + name[1:]
	query := requestURL.Query()
	for _, raw := range []string{query.Get(name), query.Get(custom), req.Header.Get(custom)} {
		if raw == "" {
			continue
		}
		if value, err := strconv.Atoi(raw); err == nil {
			return value, true
		}
	}
	return 0, false
}

// client adapts a websocket to terminal.Conn, giving each socket its own writer goroutine
// so a slow reader cannot stall the PTY that feeds it.
type client struct {
	conn   *websocket.Conn
	queue  chan []byte
	ctx    context.Context
	cancel context.CancelFunc

	once   sync.Once
	closed chan struct{}

	mu     sync.Mutex
	code   int
	reason string
}

func newClient(ctx context.Context, conn *websocket.Conn) *client {
	ctx, cancel := context.WithCancel(ctx)
	instance := &client{
		conn:   conn,
		queue:  make(chan []byte, sendQueueDepth),
		ctx:    ctx,
		cancel: cancel,
		closed: make(chan struct{}),
		code:   int(websocket.StatusNormalClosure),
	}
	go instance.writeLoop()
	return instance
}

func (c *client) SendText(data []byte) error {
	// The queue owns the bytes once handed over, and broadcast reuses its read buffer.
	frame := append([]byte(nil), data...)
	select {
	case c.queue <- frame:
		return nil
	case <-c.closed:
		return errors.New("client closed")
	default:
		// Backed up past the buffer: this client is not keeping up. Dropping it is the
		// only option that does not punish the other viewers of this face.
		c.Close(1011, "client too slow")
		return errors.New("client too slow")
	}
}

func (c *client) Close(code int, reason string) {
	c.mu.Lock()
	c.code, c.reason = code, reason
	c.mu.Unlock()
	c.stop()
}

func (c *client) stop() {
	c.once.Do(func() {
		close(c.closed)
		c.cancel()
	})
}

func (c *client) writeLoop() {
	for {
		select {
		case frame := <-c.queue:
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := c.conn.Write(ctx, websocket.MessageText, frame)
			cancel()
			if err != nil {
				c.stop()
				return
			}
		case <-c.closed:
			// Drain whatever is already queued so a shell's last words — including the
			// "process ended" notice — reach the page before the close frame does.
			for {
				select {
				case frame := <-c.queue:
					ctx, cancel := context.WithTimeout(context.Background(), time.Second)
					_ = c.conn.Write(ctx, websocket.MessageText, frame)
					cancel()
					continue
				default:
				}
				break
			}
			c.mu.Lock()
			code, reason := c.code, c.reason
			c.mu.Unlock()
			_ = c.conn.Close(websocket.StatusCode(code), reason)
			return
		}
	}
}
