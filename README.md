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
cube asleep when it is idle.

Nothing to run. Open <https://codingcube.codyh.xyz> and pick **Cloud** in Computers.

### The cloud connection on its own

```bash
cloud
```

A shell on the cloud workspace, in the terminal you typed it into, from any directory.
The cube does not come into it: the rotating six-shell GUI is a separate module that
happens to reach the same machine, and this needs none of it — no browser, no gateway, no
pairing code. This process holds the AWS credentials, so it signs its own shell URL and
connects straight to AgentCore, which is the one thing a browser cannot do and the whole
reason the website needs a minter.

`npm run shell` is the same thing from a checkout. The `cloud` command is one line in
`~/.local/bin`:

```sh
#!/bin/sh
exec node /path/to/coding-cube/src/cli/cloud-shell.js "$@"
```

Name the runtime and the profile once; both are remembered under `~/.coding-cube`, and
every run after is the bare word:

```bash
CUBE_AWS_PROFILE=coding-cube cloud --runtime-arn arn:aws:bedrock-agentcore:us-east-1:808175385344:runtime/coding_cube_nat-3RJI162JL3
cloud --face 5                                    # face 1 by default; 1..10
```

`--face N` is not a second kind of terminal. It attaches to the same herdr terminal the
cube's face N shows, so work started here is already on the cube when the cube is next
opened — and a face open in a browser cannot also be open here, because AgentCore gives
one shell id to one client (close 4000). Pick a face the browser is not using.

`ctrl-]` detaches. The shell keeps running in the cloud; so does anything running in it.

Files live on `/mnt/workspace/work`, which is **one filesystem for the whole runtime** —
a different session id lands in the same files, so there is no way to strand work by
arriving with the wrong id. It survives sleep and restarts. It does not survive an agent
runtime version update; that is the redeploy caveat in `spike/README.md`, and it is the
only thing here that can lose work.

The page is public; the cloud is not. Pair a browser once with
`https://codingcube.codyh.xyz/#token=<pairing code>` and it stays paired — the same pairing
code the local gateway uses, kept in `localStorage`, with nothing to sign in to and nothing
that expires.

The minting API is served from that origin as Cloudflare Pages Functions
(`site/functions/`), so the page and the thing that signs its shells are the same origin.
That is not a convenience: a browser cannot hold AWS credentials, so something
server-side has to sign one short-lived shell URL per face per reconnect, and an `https`
page cannot fetch `127.0.0.1` at all. Any design where the signer lives on your laptop
makes the website a decoration.

Configuring a deployment is [`site/README.md`](site/README.md) — one Access application
and three secrets.

### Running the minter locally instead

`npm start` with a runtime ARN still serves the same three endpoints on `127.0.0.1:8064`,
which is the path to use when changing them:

```bash
CUBE_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:808175385344:runtime/coding_cube_nat-3RJI162JL3 \
CUBE_AWS_PROFILE=coding-cube \
npm start
```

A page served from there mints from its own origin rather than the hosted one — see
`resolveCloudBase()` — so a local minter always wins over the deployed one while it is
running. `npm run cloud` is the same thing with a loud error instead of a silent local
start when the ARN is missing.

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
