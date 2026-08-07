# AgentCore spike

This spike answers one question: can a Coding Cube run as an Amazon Bedrock AgentCore
Runtime session — six live shells, real agents, files that survive sleep — and what does
that cost in latency and dollars.

It is deliberately split so that most of the risk is retired before any AWS resource
exists. Phase 0 is entirely local and free. Phase 1 mutates AWS and bills. Phase 2 is the
cutover, and it does not start until Phase 1 returns a verdict.

Nothing here replaces the existing local, `--expose`, or Tailscale paths.
`src/server/index.js` stays the entrypoint for those; `src/server/agentcore.js` is a
sibling used only inside the container.

## Prerequisites

Two, and **neither is installed on this machine today**. Both are local installs and both
need approval before anyone runs them.

**1. AWS CLI v2 >= 2.34.16.** Installed here is 2.33.15 (`aws --version`), whose bundled
botocore model has no `filesystemConfigurations` field at all — the flag is rejected at
argument parse, so session storage cannot be configured or even dry-run tested. 2.34.16
adds managed session storage; 2.34.44 adds the bring-your-own S3 Files and EFS members.
Homebrew stable is 2.36.16.

```bash
brew upgrade awscli
```

Note what the upgrade does *not* buy: no botocore model contains
`InvokeAgentRuntimeCommandShell`. It is a raw WebSocket API and will never appear in the
CLI, and `@aws-sdk/client-bedrock-agentcore` has no command for it either. Shell traffic
goes through `spike/harness/shell-client.mjs`, the `agentcore` CLI, or the Python
`bedrock-agentcore` SDK — never `aws bedrock-agentcore ...`.

**2. A container builder for `linux/arm64`.** None of `docker`, `finch`, `podman`, or
`nerdctl` is present. The host is darwin/arm64, so the target architecture matches
natively and a local build runs at full speed.

```bash
brew install --cask finch    # 1.17.2
finch vm init && finch vm start
```

The no-VM alternative is CodeBuild ARM64 (`spike/aws/codebuild-project.json`,
`aws/codebuild/amazonlinux-aarch64-standard:3.0`). It works, but each cycle is minutes
instead of seconds, and Phase 0 wants many cycles. Use it only if a local VM is off the
table, or for the final push.

Phase 0 needs only the builder. Phase 1 needs both.

---

## Phase 0 — local

**No AWS calls. No AWS resources. No spend.** A host bind mount stands in for managed
session storage. Roughly 80% of the spike's risk lives here: node-pty on linux/arm64,
Herdr bootstrap, six-pane fan-out, restore-after-restart, `/ping` busy logic, image size.

```bash
spike/finch.sh build      # also fails loudly above ~1.8 GB, under the 2 GB hard cap
spike/finch.sh start      # detached; binds 8080, mounts $HOME/.coding-cube-spike/workspace -> /mnt/workspace
node spike/harness/local.mjs                  # T-01, T-02, T-03, T-05, T-06, T-18
spike/finch.sh restart                        # stop + start against the SAME bind mount
node spike/harness/local.mjs --after-restart  # T-04 reads the baseline the run above wrote
```

`run` is the interactive variant of `start` and blocks the terminal, so the scripted flow
above uses `start`. The bind mount is overridable with `CUBE_MOUNT`; it defaults under
`$HOME` because Finch's Lima VM shares `$HOME` but does not guarantee host `/tmp`.

| # | Test | Proves | Reading the result |
| --- | --- | --- | --- |
| T-01 | Container boots; `/ping` answers within ~2 s of start | `node-pty` compiled for linux/arm64; `/dev/ptmx` and devpts present for `forkpty(3)` | A 200 with a JSON status. A crash on the first PTY spawn means the `node-gyp` rebuild did not run or glibc headers were missing — a musl base fails here by construction |
| T-02 | `POST /invocations {"op":"state"}` | The gateway starts `herdr server` itself (nothing in the repo does that today) and `ensureCubeWorkspace` creates Face 1–6 | `state:"ready"` plus six distinct `terminalId`s. The per-phase timings in the response **are** the measured-startup deliverable |
| T-03 | Six `/ws` connections; `echo $CODING_CUBE_FACE` in each | Six-shell fan-out and per-face environment isolation | Values 0–5 and six distinct `pane_id`s. A duplicate pane id means `selectCubeFaces` fell through its guards. Also confirms the 8-byte `CUBE` resize frame reflows |
| T-04 | Restart against the same bind mount | Restore correctness, and that `pane_history = true` actually took | Face 1–6 return with the same labels and cwds **and** non-empty screen history. Labels back but blank screens is the failure that reads to a user as data loss |
| T-05 | Run `claude` in face 1, poll `/ping` at 1 Hz | The busy classifier against real `agent_status` values | `HealthyBusy` while the agent works. `time_of_last_update` must **not** advance between pings inside one status run — if it does, the idle timeout can never fire in Phase 1 and every session runs to `maxLifetime` |
| T-06 | `ls -li ~/.config/herdr/session.json` before and after a tab rename | Whether Herdr writes atomically | A changed inode means rename-over, which silently replaces a file symlink with a regular file — keep the sync loop in `session-store.js`. Same inode means the four synced files can become symlinks and the loop can be deleted |
| T-18 | `finch images` size | Headroom under the hard, non-adjustable 2 GB image cap | Levers if over: drop `@mediapipe/tasks-vision` and `@xterm/*` (browser-only, dead under `CODING_CUBE_GATEWAY_ONLY=1`) and prune `node_modules/node-pty/prebuilds/` |

Do not proceed to Phase 1 until T-01 through T-06 and T-18 pass. Everything they measure
is cheaper to fix locally.

---

## Phase 1 — AWS

**Every item below either mutates AWS or is a billed invocation. Get explicit approval
first.** The AWS CLI upgrade is a hard gate: `spike/aws/create-runtime.sh` aborts if
`aws --version` is below 2.34.16.

```bash
spike/finch.sh push            # ECR repo + push          [MUTATES AWS]
spike/aws/create-runtime.sh    # IAM role + agent runtime [MUTATES AWS]
node spike/harness/agentcore.mjs
```

Three things the runtime must carry or shells fail outright: `agentRuntimeName` matching
`[a-zA-Z][a-zA-Z0-9_]{0,47}` (no hyphens — use `coding_cube_spike`),
`metadataConfiguration.requireMMDSV2 = true` (mandatory for agent runtimes since
2026-06-30), and creation after 2026-06-05 (any new runtime qualifies). Session IDs have a
33-character **minimum**.

The order matters. T-11 and T-10 run first because the rest of the architecture depends on
their answers.

| # | Test | Proves | Reading the result |
| --- | --- | --- | --- |
| T-07 | Push to ECR, create the runtime | The image is accepted | HTTP 424 `Failed to mount overlay` means more than 53 layers **and** a non-numeric `USER` directive. Fix the Dockerfile, not the runtime |
| T-11 | Open one shell WebSocket in us-east-1 | Region availability for `InvokeAgentRuntimeCommandShell` | Only a `ValidationException` naming *"the feature is not enabled in the target region"* justifies moving to us-west-2. Any other `ValidationException` is ours: session ID under 33 characters, agent not `READY`, or the runtime not MMDSv2-enabled. Interactive shells are GA and a dated third-party report shows them working in us-east-1, but AWS publishes no per-region statement for this API — hence one cheap check rather than a pre-emptive relocation |
| T-10 | Open `face-1`..`face-6` on session A, then `face-1` on session **B** against the same runtime | **The architecture question.** Whether the 10-concurrent-shell ceiling is scoped per runtime session or per runtime resource | B succeeds ⇒ per session, the design holds. B rejected ⇒ per resource: one concurrent Coding Cube user per runtime. **Expect rejection** — AWS's own pages run 5-to-1 toward per-resource, and there is no Service Quotas increase path for this ceiling (the account registers only a request-rate quota). Note that even the favourable reading does not fit the full grid: `terminal-grid.js` has `FACE_MAX=5` and `SLOT_MAX=3`, a 6×4 = 24-PTY addressable space |
| T-08 | First invoke on a fresh session ID; time to `state:"ready"` | Cold start — the headline number | Read it against `terminals.js`'s reconnect backoff: a 30–60 s cold start burns several doublings across six faces and lands at the 60 s cap showing *"retrying in 60s"*. The fix is a waking state in the UI, which is Phase 2 work |
| T-09 | `{"op":"probe"}` | The four undocumented properties of the platform-spawned PTY: `$SHELL`, `TERM`, uid, cwd, `$HOME` | Run this **before** trusting `cube-face`. Baking `HERDR_SOCKET_PATH` removes the `$HOME` dependency entirely, but a non-POSIX shell would still break the `exec` bootstrap line |
| T-12 | Idle 90 s reporting `Healthy`, then re-invoke, then `{"op":"hold","seconds":120}` | Sleep/wake, and that `HealthyBusy` actually suppresses the idle timeout | Expect a `0xFF` CLOSE frame or close 1001 when the VM dies, then a measurable warm restore. If the VM dies **during** the hold, the platform did not accept our `HealthyBusy` spelling — AWS's getting-started example returns lowercase `healthy`, which contradicts the protocol contract's enum |
| T-13 | Two session IDs, a distinct file in each, cross-read | Isolation | Any successful cross-read is a stop-the-line finding |
| T-14 | Authenticate Claude and Pi in the VM, run one real turn, then read `/mnt/workspace/.cube/ping-trace.ndjson` | Real agent execution, and ground truth for `agent_status` transitions | Confirms which enum values actually appear and whether `agent` reliably rides on the event payload (it is schema-optional). Do not ship production `/ping` logic without this trace |
| T-15 | Open a shell **without ever calling** `/invocations`, then `ls /mnt/workspace` | Whether the mount exists for shell-only sessions | The docs say the mount is available *"only at the time of agent invocation"*. If it is absent, `cube-wait-face` must trigger an invocation itself rather than merely waiting |
| T-16 | `spike/browser/index.html` + `spike/mint-server.mjs`, xterm.js on `face-1` | Browser-direct reachability with no proxy | Three things must hold: the shell ID comes from the first `0x03` STATUS frame (browsers cannot read 101-handshake response headers); a 30 s `0x05` heartbeat keeps a quiet face alive past ~15 minutes; and the 300 s presign expiry plus the 1-hour forced close both round-trip through re-mint and reconnect with shell state intact and ≤256 KB replayed. T-16 itself is driven by hand in a browser; `node spike/harness/agentcore.mjs T-16a` is its headless half, dropping the socket and reattaching the same `shellId` so the reconnect path is exercised in seconds rather than an hour |
| T-17 | Do `?face=N` query params survive the `/ws` passthrough? | Viability of the fallback transport | Only load-bearing if T-10 forces the fallback. If neither the query param nor `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Face` arrives, the client HELLO frame is the only mechanism |

**Stop-the-line conditions**

- T-10 says per-resource **and** T-17 shows the passthrough unusable → AgentCore is not
  viable for multi-user. Move the same image to Cloudflare Sandbox; the container work is
  unchanged.
- T-11 fails in us-east-1 and again in us-west-2 → native shells are unavailable;
  passthrough only.
- T-13 cross-read succeeds → stop everything and report.

**Cost.** Runtime bills $0.0895 per vCPU-hour and $0.00945 per GB-hour, per second, with a
one-second minimum. Memory is billed for the whole session including idle. Six shells idle
at ~2 GB is roughly $0.02/hour, which is trivial for a spike and misleading as a
production model. Do not leave sessions open, and run the teardown printed by
`create-runtime.sh` when you are done — it deletes the runtime, and session storage goes
with it.

The spike runtime uses `idleRuntimeSessionTimeout=60` (the minimum) purely to turn
sleep/wake from a 15-minute wait into ~90 seconds. **Do not ship those values.**

---

## Phase 2 — cutover

Only after Phase 1 returns a verdict on T-10, T-11, and T-16.

The seam is genuinely three lines in `public/app/terminals.js`: accept a transport instead
of importing `hostWebSocket`, swap `new WebSocket(...)` for `transport.openTerminal(...)`,
and swap the inline resize `DataView` for `transport.encodeResize(...)`. Everything else —
xterm construction, focus/blur, the local-shell fallback, the reconnect block — stays as
it is. `public/app/transport.js` is written during Phase 0 as an additive file with no
edits to `terminals.js` or `main.js`, precisely so this step is small and reversible.

Out of scope for the spike, and required before anything reaches a second user:

- Production auth. `spike/mint-server.mjs` is loopback-only and holds one developer's own
  AWS credentials. The presign path is the only one where authorization is enforceable:
  AgentCore maps no session to any user and there is no IAM condition key for session ID,
  so a JWT authorizer cannot stop a valid token from naming someone else's
  `runtimeSessionId`.
- The waking / sleeping / saving lifecycle states in the Cube UI.
- A persistence answer that survives an image redeploy. Managed session storage is wiped
  on every agent runtime version update.

## Reading the results

Both harnesses print a machine-readable results JSON path at the end of the run; per-phase
bootstrap timings also land in `/mnt/workspace/.cube/boot.log` and `bootstrap.json`, and
every `/ping` decision is traced to `/mnt/workspace/.cube/ping-trace.ndjson`. When a
Phase 1 result contradicts this README, the result wins — write the correction back into
`ON_DEMAND_CODING_CUBE_SERVICE_PLAN.md` rather than leaving it in a terminal.

---

## Using the Cube against AgentCore (single operator)

The browser now has a second transport. `public/app/terminals.js` no longer hardcodes
`/ws/pty` — it asks a transport to open each face, and `main.js` picks one from the active
host's `kind`. Nothing about the Cube itself changed.

For one operator there is **no control plane**. `spike/mint-server.mjs` runs on loopback,
holds your AWS credentials, and signs one short-lived shell URL at a time. A browser cannot
hold AWS credentials, and loopback is the same trust boundary the Tailscale gateway already
relies on — so this is the whole of it. It uses the AWS SDK's long-lived credential provider
and Smithy signer; when `aws login` expires, the minter stays up but the browser stops all
automatic reconnects. Run `aws login`, then choose **Retry**. Multi-user swaps that origin
for an authenticated API and changes nothing else in the client.

```sh
# 1. the minter (holds your AWS credentials; loopback only)
node spike/mint-server.mjs \
  --runtime-arn arn:aws:bedrock-agentcore:us-east-1:808175385344:runtime/coding_cube_nat-3RJI162JL3 \
  --origin "https://codingcube.codyh.xyz,http://127.0.0.1:8064"

# 2. the app
npm start
```

Open the Cube, then pick **Cloud (AgentCore)** in Computers. Six faces attach to `face-1`
… `face-6` on one runtime session.

`--origin` is **comma-separated in a single flag**; passing it twice keeps only the last.
The query parameter is `sessionId`, not `session`.

### What the client guarantees

- **One session id per browser**, in `localStorage` under `coding-cube.agentcore.session`.
  That id *is* the workspace — minting a fresh one silently strands the previous machine's
  files, so it is deliberately persisted rather than regenerated per load.
- **Bootstrap before attach, structurally.** `createShellTransport` takes `ensureWorkspace`
  as a *required constructor argument* and every face awaits it. `/mnt/workspace` only
  materialises on the first `/invocations` call, so a shell opened before that would run on
  storage that evaporates at idle timeout — silently. It cannot be forgotten.
- **Scrollback is restored client-side** before the live stream starts. AgentCore replays
  only what was missed while disconnected, never the screen, so this is load-bearing rather
  than a nicety.
- **Switching hosts swaps the transport** (`fleet.setTransport`), closing the old sockets
  first so a stale AgentCore shell cannot replay into a face that now belongs elsewhere.

### Verified end to end

```
prepare  -> state=ready faces=6 durable=true      (1437 ms)
mint     -> wss://bedrock-agentcore.us-east-1…    (300 s expiry, refresh after 270 s)
connect  -> open, reconnected=false
shell    -> command echoed back OK
CORS     -> https://evil.example 403 · https://codingcube.codyh.xyz 200
```
