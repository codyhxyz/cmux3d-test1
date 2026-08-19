# The Go terminal gateway

A drop-in replacement for `node src/server/index.js` — the process that serves the cube's
page, the herdr state API, and the PTY websockets.

The reason it exists is deployment, not speed. `node-pty` is a native module, so putting the
gateway on the ARM EC2 box described in [`../../cloud-agent`](../../cloud-agent) meant a Node
runtime plus a node-gyp build on the target architecture. This is one static binary:

```sh
make dist          # linux/arm64, linux/amd64, darwin/arm64, darwin/amd64
scp dist/coding-cube-linux-arm64 the-box:/usr/local/bin/coding-cube
```

`file` on that artifact reports `ELF 64-bit LSB executable, ARM aarch64, statically linked`.
Nothing else has to be installed for it to run.

## What it does and does not own

| Surface | Owner |
| --- | --- |
| Static page, `/vendor/*` assets | **Go** |
| `/health`, `/api/host/info` | **Go** |
| `/api/herdr/state`, `/api/herdr/events` (SSE) | **Go** |
| `/ws/pty` and `/ws` terminal sockets, PTY grid | **Go** |
| Pairing-code store, origin and tailnet auth | **Go** |
| Tailscale detection, whois identity, Serve | **Go** |
| **AgentCore minting, sessions, `/invocations`, `/ping`** | **Node** (`src/server/cloud/`, `agentcore.js`, `session-store.js`, `busy.js`) |
| **`coding-cube pair` and the QR CLI** | **Node** (`src/cli/`) |

`--cloud` is a hard error here rather than a silent no-op, because this binary has no minter
to satisfy it. Run the Node server for the AWS path. The Node server remains fully intact and
is still the reference implementation; nothing was deleted.

The browser is untouched. `public/` is served byte-for-byte identically — xterm, the MediaPipe
hand-tracking wasm and the cube renderer never knew which gateway answered.

## Running it

```sh
make build
CODING_CUBE_OPEN=0 CODING_CUBE_HERDR=herdr bin/coding-cube
```

Every environment variable the Node server reads is read here the same way:
`PORT`, `HOST`, `CODING_CUBE_WORKDIR`, `CODING_CUBE_SHELL`, `CODING_CUBE_HERDR`,
`CODING_CUBE_WORKSPACE`, `CODING_CUBE_WEB_ORIGIN`, `CODING_CUBE_GATEWAY_ONLY`,
`CODING_CUBE_TOKEN`, `CODING_CUBE_STATE_DIR`, `CODING_CUBE_ROTATE_TOKEN`,
`CODING_CUBE_TAILSCALE`, `CODING_CUBE_TAILSCALE_USERS`, `CODING_CUBE_REQUIRE_CODE`,
`CODING_CUBE_LOCAL_ONLY`, `CODING_CUBE_OPEN`.

One addition: `CODING_CUBE_ROOT` names the checkout whose `public/` and `node_modules/` to
serve. Without it the binary walks up from its own location looking for `public/index.html`,
then falls back to the working directory — so `bin/coding-cube` inside a checkout just works.

`node_modules` is still required *as a file store* for the `/vendor/*` routes, which serve
xterm and MediaPipe straight out of it. The gateway never executes any of it.

## Verified against the Node server

Both were run side by side against the same checkout and the same live herdr:

- `/health` and `/api/host/info` — byte-identical JSON, including key order.
- `/`, `/app/*.js`, `/vendor/xterm.mjs`, `/vendor/qrcode.mjs`, and the 11 MB
  `vision_wasm_internal.wasm` — byte-identical.
- `/api/herdr/state` against the live six-face workspace — byte-identical, including each
  face's embedded snapshot with its focus fields rewritten.
- Status and content-type parity on `/api/herdr/state` (503 when herdr is off),
  `/api/herdr/events` (204 when off), unknown paths (404), traversal attempts (403), and
  non-GET methods (405).
- SSE: `data: ready` then `data: change` on a real `herdr tab rename`.
- A real websocket attach to a live herdr terminal, resized with a `CUBE` frame and echoing
  a command back.

## Deliberate differences from the JS

Three, all documented at the call site:

1. **UTF-8 boundaries.** `node-pty` decoded PTY output to a string, which buffered partial
   multi-byte sequences across reads. Go reads raw bytes, so `splitRunes` holds back an
   incomplete rune until its continuation arrives. Without it a `é` split across two reads
   would produce an invalid text frame.

2. **Slow clients are dropped, not tolerated.** The JS fanned out with a synchronous
   `ws.send` inside the PTY data handler, so one stalled socket could back-pressure the
   shell for everyone watching that face. Each client here owns a buffered writer goroutine
   and is closed with 1011 if it falls more than `sendQueueDepth` frames behind.

3. **`repairDarwinPtyHelper` is gone.** It chmod'd `node-pty`'s prebuilt `spawn-helper`
   binary. There is no helper binary to repair.

## Tests

```sh
make check     # gofmt + go vet + go test -race
```

The suite spawns real PTYs and real websockets rather than mocking them — `grid_test.go`
runs `/bin/sh`, and `gateway_test.go` drives the actual handler over a real socket,
including a `tput cols` round-trip that proves the resize frame reached the terminal.
`herdr_test.go` covers the snapshot logic that is easiest to get subtly wrong: the
create-only setup plan, the first-gap face count, and the requirement that an unmodelled
snapshot field survives the round-trip to the browser.
