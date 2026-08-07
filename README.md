# Coding Cube

A rotatable workspace for six shells. It runs with ordinary local shells out of the box and can attach each face to a tab in a persistent Herdr `Coding Cube` workspace.

## Run

```bash
npm install
npm start
```

`npm start` opens <https://codingcube.codyh.xyz> with a pairing code. Click a face and type: each face starts an ordinary shell in the current directory. Terminals and files remain on the computer running `npm start`. If the hosted page cannot connect, open <http://127.0.0.1:8064/>.

The pairing code is stored in `~/.coding-cube/token`, so devices you have paired stay paired across restarts. Rotate it with `npm start -- --rotate-token`.

To use another working directory or a local-only custom port:

```bash
CODING_CUBE_WORKDIR="$PWD" npm start
PORT=8070 CODING_CUBE_OPEN=0 npm start
```

To use persistent Herdr terminals instead of disposable shells:

```bash
CODING_CUBE_HERDR=herdr npm start
CODING_CUBE_HERDR=herdr CODING_CUBE_WORKSPACE="My Cube" npm start
```

Herdr mode idempotently creates the workspace and its `Face 1` through `Face 6`
tabs when missing. Existing faces and unrelated workspaces or tabs are left alone.

## In the cloud

The six faces can run on an AWS Bedrock AgentCore runtime instead of this machine —
files on EFS at `/mnt/workspace`, compute billed only while it is awake, and the whole
cube asleep when it is idle. One command:

```bash
CUBE_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:808175385344:runtime/coding_cube_nat-3RJI162JL3 \
CUBE_AWS_PROFILE=coding-cube \
npm start
```

Open <http://127.0.0.1:8064/> and pick **Cloud (AgentCore)** in Computers. Put those two
exports in your shell profile and it is just `npm start`.

`CUBE_RUNTIME_ARN` is the whole switch: without it there is no `/mint` endpoint and
nothing about the local cube changes. `npm run cloud` is the same thing with a loud
error instead of a silent local start when the ARN is missing.

The Cube and the minting API are served from **one origin** on purpose. A browser cannot
hold AWS credentials, so the server signs one short-lived shell URL per face per
reconnect — and Chrome now refuses an `https` page's fetch to `127.0.0.1` outright, so
the page has to come from the same place as the API rather than reaching across to it.

### The AWS profile

`CUBE_AWS_PROFILE` names a profile whose credentials do not expire. Without one the
server falls back to the default chain, which for `aws login` means it stops minting
roughly once a day: every face reports `AWS login required`, stops reconnecting, and
waits for you to run `aws login` and press **Retry**.

To create a user that can do exactly two things — invoke that one runtime and open
shells on it — and store its key in the profile:

```bash
sh spike/aws/create-minter-user.sh --dry-run   # read-only; prints the policy
sh spike/aws/create-minter-user.sh             # asks before it mutates AWS
```

It creates nothing else and can delete nothing, which matters because the key sits in
plaintext in `~/.aws/credentials`. The script prints its own teardown.

`spike/aws/create-runtime.sh`, `create-efs.sh` and `create-egress.sh` build the runtime
itself; `spike/README.md` covers that, and `spike/RESULTS.md` is what was measured.

## Controls

- Drag to orbit the cube
- Click a face or use the face rail to focus its shell
- Type directly into the focused terminal
- Pinch or scroll to zoom
- Move the pointer to nudge the default zero-gravity drift
- Adjust face opacity, momentum duration, or zero gravity in Settings
- Choose a webcam and enable Hand control in Settings, then pinch either hand to orbit or pinch both to orbit and zoom
- Tap away from the cube, or press `Esc`, to release focus

## On a phone

Phones get the same six shells, not a preview. The cube needs a computer to run them on. With Tailscale installed on both devices under the same account:

```bash
npm start -- --expose
```

That binds to your tailnet address and prints a link like `http://mymac.tail1234.ts.net:8064/#token=…`. Open it on the phone — the link carries both the address and the pairing code — and you are connected. Nothing else to configure: no certificate, no `tailscale serve`, no port forwarding.

Once connected, tap a face to focus it and the keyboard comes up. A key row above the keyboard carries `esc`, `tab`, a sticky `ctrl`, arrows, and paste. Tap away from the cube to release.

To reach terminals through the hosted cube, use Tailscale Serve. The gateway
stays on loopback while Tailscale provides TLS and authenticated identity:

```bash
CODING_CUBE_TAILSCALE=serve \
CODING_CUBE_TAILSCALE_USERS="you@example.com" \
CODING_CUBE_GATEWAY_ONLY=1 \
CODING_CUBE_HERDR=herdr npm start
```

`CODING_CUBE_GATEWAY_ONLY=1` keeps the visual app on the hosted site; that process
serves only health, Herdr state, events, and terminal WebSockets.

The hosted cube can then connect without a pairing prompt on devices signed into
that tailnet. `CODING_CUBE_TAILSCALE_USERS` is an optional comma-separated allowlist;
a request outside it can still use the ordinary pairing-code path. Serve strips
spoofed identity headers before forwarding requests to the loopback gateway.

Direct exposure remains opt-in with `--expose`. It binds only the tailnet
interface, never the LAN or public internet.

## Verify

```bash
npm run smoke
```

In Herdr mode, per-face views of the canonical snapshot are available at `GET /api/herdr/state`.

Hand control is off by default. MediaPipe runs in a browser worker; camera frames are processed locally and are not uploaded.

The server binds to loopback by default because every terminal is a real shell with access to the configured working directory.
