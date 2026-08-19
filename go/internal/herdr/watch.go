package herdr

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"sync"
	"time"
)

const subscriptionID = "coding-cube"

var socketPattern = regexp.MustCompile(`(?m)^socket:\s*(.+)$`)

type subscription struct {
	Type   string `json:"type"`
	PaneID string `json:"pane_id,omitempty"`
}

type request struct {
	ID     string `json:"id"`
	Method string `json:"method"`
	Params struct {
		Subscriptions []subscription `json:"subscriptions"`
	} `json:"params"`
}

type reply struct {
	ID    string          `json:"id"`
	Event json.RawMessage `json:"event"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Watch subscribes to the herdr event stream and calls onChange (debounced 250ms) for
// every event, onDisconnect once the stream dies. The returned stop function is safe to
// call more than once.
//
// onEvent receives each event unmodified, because /ping needs the agent_status the 250 ms
// change debounce throws away.
func (client *Client) Watch(
	ctx context.Context,
	workspaceLabel string,
	onChange func(),
	onDisconnect func(),
	onEvent func(json.RawMessage),
) (func(), error) {
	// Every face that exists, hidden ones included: `pane.agent_status_changed` cannot be
	// subscribed without a pane_id, so a pane left out here is an agent nothing is
	// watching — which is exactly the blind window that made a healed face sleepable.
	state, err := client.ReadState(ctx, workspaceLabel, -1)
	if err != nil {
		return nil, err
	}

	status, err := client.run(ctx, "status", "server")
	if err != nil {
		return nil, err
	}
	match := socketPattern.FindSubmatch(status)
	if match == nil {
		return nil, fmt.Errorf("HerdR did not report its default session socket")
	}
	socketPath := string(match[1])

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, err
	}

	var message request
	message.ID = subscriptionID
	message.Method = "events.subscribe"
	for _, eventType := range eventTypes {
		message.Params.Subscriptions = append(message.Params.Subscriptions, subscription{Type: eventType})
	}
	for _, face := range state {
		message.Params.Subscriptions = append(message.Params.Subscriptions,
			subscription{Type: "pane.agent_status_changed", PaneID: face.PaneID})
	}
	payload, err := json.Marshal(message)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		conn.Close()
		return nil, err
	}

	watcher := &watcher{conn: conn, onChange: onChange, onDisconnect: onDisconnect, onEvent: onEvent}
	ready := make(chan error, 1)
	go watcher.read(ready)

	// The JS awaited the subscription ack before returning, so a failed subscribe is a
	// failed call rather than a stream that silently never fires. Keep that.
	select {
	case err := <-ready:
		if err != nil {
			watcher.stop()
			return nil, err
		}
	case <-time.After(10 * time.Second):
		watcher.stop()
		return nil, fmt.Errorf("HerdR did not acknowledge the event subscription")
	case <-ctx.Done():
		watcher.stop()
		return nil, ctx.Err()
	}
	return watcher.stop, nil
}

type watcher struct {
	conn         net.Conn
	onChange     func()
	onDisconnect func()
	onEvent      func(json.RawMessage)

	mu      sync.Mutex
	stopped bool
	timer   *time.Timer
	ready   bool
}

func (w *watcher) stop() {
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return
	}
	w.stopped = true
	if w.timer != nil {
		w.timer.Stop()
	}
	w.mu.Unlock()
	w.conn.Close()
}

// changed debounces at 250ms: a burst of tab and pane events is one state change to
// anything reading the snapshot afterwards.
func (w *watcher) changed() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return
	}
	if w.timer != nil {
		w.timer.Stop()
	}
	w.timer = time.AfterFunc(250*time.Millisecond, func() {
		w.mu.Lock()
		stopped := w.stopped
		w.mu.Unlock()
		if !stopped {
			w.onChange()
		}
	})
}

func (w *watcher) read(ready chan<- error) {
	scanner := bufio.NewScanner(w.conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)

	fail := func(err error) {
		w.mu.Lock()
		alreadyReady, stopped := w.ready, w.stopped
		w.mu.Unlock()
		if stopped {
			return
		}
		if !alreadyReady {
			ready <- err
			return
		}
		w.stop()
		w.onDisconnect()
	}

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var message reply
		if err := json.Unmarshal(line, &message); err != nil {
			fail(err)
			return
		}
		if message.Error != nil {
			fail(fmt.Errorf("%s", message.Error.Message))
			return
		}
		if message.ID == subscriptionID {
			w.mu.Lock()
			w.ready = true
			w.mu.Unlock()
			ready <- nil
			continue
		}
		if len(message.Event) > 0 {
			if w.onEvent != nil {
				w.onEvent(message.Event)
			}
			w.changed()
		}
	}

	err := scanner.Err()
	if err == nil {
		err = fmt.Errorf("HerdR event stream closed")
	}
	fail(err)
}
