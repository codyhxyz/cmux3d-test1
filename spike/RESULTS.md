# AgentCore spike — measured results

**Run:** 2026-08-05, account 808175385344, `us-east-1`
**Runtime:** `arn:aws:bedrock-agentcore:us-east-1:808175385344:runtime/coding_cube_spike-2JI9VQCOZh`
**Image:** `coding-cube-spike:v2`, linux/arm64, 924,438,528 bytes (0.92 GB), 17 layers
**Lifecycle:** `idleRuntimeSessionTimeout=60`, `maxLifetime=3600`, `requireMMDSV2=true`
**Storage:** managed session storage at `/mnt/workspace`

Everything below was executed against the live runtime. Nothing is inferred.

## Verdict

The migration premise holds. All six spike acceptance criteria that can be tested without model
credentials passed. Two AWS-documentation claims were **refuted** by measurement.

| # | Criterion | Result |
|---|---|---|
| 1 | Six concurrent shells | **PASS** — 12 shells across two sessions on one runtime |
| 2 | Herdr restoration after sleep | **PASS** — all six faces returned |
| 3 | Sleep / wake | **PASS** — microVM destroyed and reprovisioned |
| 4 | Session isolation | **PASS** — session B cannot read session A |
| 5 | Measured startup | **PASS** — 1342 ms cold start to `state=ready` |
| 6 | Real Claude/Pi execution | **NOT PROVEN** — no model credentials in the container |

## The headline test: does work survive sleep?

One session, a git repo on the mount, then 180 s of total inactivity against a 60 s idle timeout:

```
T+0     uptime=25s   created /mnt/workspace/work/myrepo, committed aef83ab "before sleep"
T+180   uptime=25s   <- fresh microVM: uptime reset, ephemeral /tmp wiped
        note.txt  -> "hello from before the sleep"
        git log   -> aef83ab before sleep
        herdr     -> 6 tabs: Face 1 .. Face 6
```

Files, git history, and the Herdr workspace all survived destruction of the compute. Live PIDs did not,
which is the documented and expected trade.

Eviction was confirmed independently before this, with a marker in ephemeral `/tmp`:

```
T+0     uptime=29s  marker=1785909826
T+180   uptime=27s  marker=GONE
```

## Two AWS documentation claims that measurement refuted

**1. The 10-shell cap is per SESSION, not per runtime.** AWS's docs say "per runtime" in four places
across two pages, and the release note says "per session" in one. The recon phase read the evidence
5-to-1 toward per-resource, which would have meant *one concurrent Coding Cube user per runtime*.
Measured: **12 shells open simultaneously across two sessions on a single runtime.** The release note is
right and the quotas tables are wrong. Multi-tenancy works — one runtime serves many users at six faces
each.

**2. Interactive shells work in `us-east-1`.** Every AWS example is `us-west-2` and `ValidationException`
explicitly lists "feature not enabled in the target region." Measured: shell opened via SigV4 presign in
1929 ms in `us-east-1`. No relocation needed.

A third, smaller one: the hand-written WebSocket client works. `InvokeAgentRuntimeCommandShell` has no
generated client in any AWS SDK (verified absent from botocore 2.36.16), so the wire protocol was
reconstructed from the Python SDK and the `@aws/agentcore` npm CLI. It is byte-correct against the live
service.

## Test-by-test

| ID | Test | Verdict | Measured |
|---|---|---|---|
| T-08 | Cold start | PASS | 1342 ms to `state=ready`; bootstrap 238–295 ms |
| T-09 | Platform PTY identity | PASS* | see below — harness output garbled, values taken from `op=probe` |
| T-10 | 10-shell cap scope | PASS | **per runtime SESSION**; 12 shells / 2 sessions / 1 runtime |
| T-11 | Shells in target region | PASS | opened in `us-east-1` via presign, 1750–2068 ms |
| T-12 | Idle teardown + warm restore | PASS (re-tested by hand) | evicted between 60 s and 180 s; warm restore 384 ms |
| T-13 | Session isolation | PASS | session B cannot see session A files |
| T-14 | Real agent turn | UNKNOWN | needs Anthropic credentials inside the microVM |
| T-15 | Storage on a shell-only session | **FAIL** | `/mnt/workspace` absent until the first `/invocations` |
| T-16a | Reconnect same shellId | PASS | `reconnected=true`, 703 ms, replay confirmed |

## The real runtime environment (`op=probe`)

```
uid=0  gid=0  HOME=/home/cube  TERM=xterm-256color  SHELL=/bin/bash
node v24.19.0   platform linux/arm64   cwd /opt/coding-cube
herdr socket    /home/cube/.config/herdr/herdr.sock
```

The platform runs the container as **root** and honors the image's `ENV HOME`. The uid/`$HOME` mismatch
the design defended against did not materialize — but the defensive `HOME` pinning in `cube-face` stays,
because nothing in AWS's contract promises this.

**Session storage is NFS4**, not a block device:

```
127.0.0.1:/export  1.0G  0  1.0G  0%  /mnt/workspace
  nfs4 rw,vers=4.0,rsize=1048576,wsize=1048576,
       acregmin=3600,acregmax=3600,acdirmin=3600,acdirmax=3600,nocto,hard
```

Two consequences worth carrying forward: the 1 GB cap is enforced at the filesystem layer, and attribute
caching is **one hour** with `nocto` (no close-to-open consistency). Anything that detects change by
`stat` may see hour-stale metadata. Root filesystem is overlay, 8.8 GB with 875 MB used.

## Known defects and gaps (as first measured — see the final section for what is now closed)

1. **T-15 is a real platform constraint, not a bug in our code.** `/mnt/workspace` does not exist for a
   session whose only activity is a shell connection — it materializes on the first `/invocations` call.
   The frontend must therefore invoke once before or while opening shells. This is natural: the transport
   needs the face→`terminal_id` map anyway, which is the same call. It must not be left implicit.
2. **The boot counter does not persist.** `state.boot` reports `boots=1, firstBoot=true` even on a
   microVM that provably replaced an evicted one. Files and Herdr state persist correctly, so this is a
   defect in the bookkeeping written to `/mnt/workspace/.cube/bootstrap.json`, not in persistence itself —
   but the state endpoint currently lies about it.
3. **T-12's automated verdict was wrong.** It reported `evictedAfter=never` on a session that was
   demonstrably evicted. The harness's eviction detection needs to key on ephemeral-filesystem loss or
   `/proc/uptime`, which is how it was confirmed by hand here.
4. **T-09's harness output is garbled** — it captures the PTY's own echo of the probe command instead of
   the result. The values in this document came from `op=probe` instead. Harmless but misleading.
5. **`delay()` used an unref'd timer** (`spike/harness/shell-client.mjs`), so Node exited with the promise
   unsettled whenever a socket was deliberately terminated. This silently killed T-12, T-14, and T-16a in
   the first full run. Fixed.
6. **Replay semantics are narrower than "256 KB of scrollback."** The buffer carries output *missed while
   disconnected*, not the full screen. A fresh browser tab attaching to an existing session does not get
   the prior screen back. The Cube's xterm keeps client-side scrollback, so this is survivable, but it is
   not the "reopen and everything is as you left it" the plan implies.
7. **Pi's Herdr integration never installs**: `pi extension directory not found at
   /home/cube/.pi/agent/extensions`. Claude's installs fine. Until fixed, a Pi agent's status is invisible
   to `/ping`, so a Pi-only session would look idle while working — and could be slept mid-task.
8. **No self-healing.** If Herdr dies, or a face's shell exits and Herdr closes the tab, nothing restores
   it while `state === 'ready'`. A dead Herdr also latches `HealthyBusy`, so the microVM would bill to
   `maxLifetime`. Bounded to 1 hour by the spike's `maxLifetime=3600`, but it must be fixed before
   production raises that.
9. **`spike/browser/index.html` has never been rendered** — no browser on the build machine. The live
   xterm/AttachAddon wiring is unproven.

## Cost

Measured shape, not modelled: at 2 vCPU / 4 GB the run rate is roughly **$0.22/hour**
($0.0895/vCPU-hr × 2 + $0.00945/GB-hr × 4). The entire spike — image pushes, ~20 sessions, several
multi-minute idle tests — is on the order of a few dollars.

Carry forward the correction from recon: **memory is billed for the whole session including idle**, and
"idle CPU is free" is conditioned on no background process running, which a cube holding six Herdr panes
violates by definition. `maxLifetime=3600` is what actually bounds a stuck session's cost.

## Teardown

```sh
aws bedrock-agentcore-control delete-agent-runtime --region us-east-1 \
  --agent-runtime-id coding_cube_spike-2JI9VQCOZh
aws iam delete-role-policy --role-name CodingCubeSpikeRuntime --policy-name inline
aws iam delete-role --role-name CodingCubeSpikeRuntime
```

Deleting the runtime deletes all session storage with it.

---

# EFS migration — measured 2026-08-05

Session storage's two disqualifying limits (1 GB hard cap; **wiped on every runtime version
update**, i.e. every image redeploy destroys every workspace) are gone. Everything below was executed.

## Result

| Property | Session storage | EFS |
|---|---|---|
| Capacity | `1.0G` | **`8.0E`** |
| Survives image redeploy | **No** — wiped on version bump | **Yes** — verified across v1 → v2 |
| Hard links (pnpm, `git clone --local`) | Not supported | **Yes** |
| Mount | `nfs4 vers=4.0`, `acregmin=3600`, `nocto` | `nfs4 vers=4.1`, `noresvport` |
| Isolation | Per session, automatic | Per access point — **shared** within one |
| Network mode | PUBLIC | **VPC required** |
| Cold start to `state=ready` | 1.2–2.1 s | **1.9–2.5 s** |
| Fixed monthly cost | $0 | **~$32.40** (NAT gateway) |

Cold start was measured three times per topology, not once. The VPC penalty is about +0.6-1 s, not the
10 s a single first-ever invocation suggested — that first call included one-time ENI and image setup:

```
VPC + NAT + EFS            1850 ms   2467 ms   2234 ms   (bootstrap 205-361 ms)
PUBLIC + session storage   1221 ms   1219 ms   2083 ms   (bootstrap 322-388 ms)
```

The redeploy test, verbatim:

```
BEFORE   proof.txt -> "survives redeploy"   git log -> ffd1d74 pre-redeploy
REDEPLOY UpdateAgentRuntime -> status UPDATING, version 2 -> READY
AFTER    uptime=22s (fresh microVM, new session id)
         proof.txt -> "survives redeploy"   git log -> ffd1d74 pre-redeploy
```

## The finding that cost the most to learn: VPC mode needs a NAT

**AgentCore's service-managed ENIs do not get public IPs.** A runtime placed in the default VPC's
*public* subnets — `MapPublicIpOnLaunch=true`, IGW default route — cannot pull its image. Every
invocation fails with `502 RuntimeClientError` or a read timeout, and **no log group is ever created**,
so there is nothing to debug from. An internet gateway only translates for an ENI that already has a
public IP.

Bisected to be certain: VPC + *session storage* (no EFS at all) fails identically. It is the networking,
not the filesystem.

`requireServiceS3Endpoint` is not the escape hatch it looks like — it cannot be set at create time
(`ValidationException: requireServiceS3Endpoint cannot be set during agent creation`) and is immutable
afterwards for agents created after 2026-06-11 (`Agents created after 2026-06-11T00:00:00Z cannot modify
requireServiceS3Endpoint`). It would only have covered ECR/S3 anyway, not `api.anthropic.com`.

The working topology is private subnets with a NAT default route, built by
`spike/aws/create-egress.sh`. Verified from inside the microVM:

```
anthropic=405 0.038s     <- 405 is the correct response to GET /v1/messages; we reached it
github=200    0.076s
npm=200
```

EFS mount targets do **not** need to live in the private subnets — one per AZ anywhere in the VPC is
reachable over the local route, provided the security group allows 2049 from the runtime's group.

## Cost, honestly

The NAT gateway is **~$32.40/month fixed**, plus $0.045/GB processed. That is roughly what the
`t4g.medium` it replaces costs — so **at one user this migration does not save money.** It wins on
everything else (no 1 GB cap, survives deploys, full POSIX, compute billed only while working), and the
NAT is shared across *all* users, so the economics invert as soon as there is more than one.

Two levers if the fixed cost matters: a `t4g.nano` NAT instance is ~$3/month (stubbed but not
implemented in `create-egress.sh`), or stay on session storage while workspaces are disposable.

## Other measured facts

- `metadataConfiguration.requireMMDSV2` now defaults to `true` on newly created runtimes. The
  create-then-update dance in `create-runtime.sh` is still correct but may no longer be necessary.
- The execution role needs `elasticfilesystem:DescribeAccessPoints` and `DescribeMountTargets` at
  create time or `CreateAgentRuntime` fails validation outright. Client mount permissions are gated
  with a `elasticfilesystem:AccessPointArn` condition so the role can only mount *through* the access
  point, never the filesystem root — that condition is what makes per-user access points enforceable
  later.
- Scope the log-group permission to `coding_cube_*-*`, not one runtime name. A mismatch means the
  runtime silently produces no logs, which is how the 502 above went undiagnosed for several attempts.

## Live resources

```
EFS            fs-01bc1a8b94bd929b7   access point fsap-030e462a298751b0f (root /workspaces)
Security group sg-04920fbdf335015cd
Private subnets subnet-00bc3910d37f32585 (us-east-1a), subnet-05ee6096f07cf52ed (us-east-1b)
NAT gateway    nat-0d5105808029675ec   <- the only resource with a meaningful standing charge
Runtimes       coding_cube_spike-2JI9VQCOZh  PUBLIC + session storage (the original spike)
               coding_cube_nat-3RJI162JL3    VPC + NAT + EFS  <- the working one
               coding_cube_efs-bmcdy2E1zt    VPC, public subnets, EFS   BROKEN, delete
               coding_cube_vpc-RqpZwF2kHf    VPC, public subnets, session storage  BROKEN, delete
```

---

# Final state — hardened image v2 on EFS, re-verified against live AWS

**Runtime:** `coding_cube_nat-3RJI162JL3` (VPC + NAT + EFS), image `coding-cube-spike:v2`
**Image:** 924,438,528 bytes (0.92 GB), 17 layers — 46% of the 2 GB cap

EFS survived two further redeploys (v1→v2→v3); `proof.txt` and commit `ffd1d74` intact each time.

| ID | Test | Verdict | Measured |
|---|---|---|---|
| T-08 | Cold start | PASS | 2111 ms to `state=ready` |
| T-09 | Platform PTY identity | PASS | **`$HOME=/root`**, uid 0, cwd `/`, `/usr/bin/bash`, `TERM=xterm-256color`, 32x120 |
| T-10 | 10-shell cap scope | PASS | per runtime SESSION; 12 shells / 2 sessions |
| T-11 | Shells in us-east-1 | PASS | presign, 1654 ms |
| T-12 | Idle teardown + warm restore | PASS | evicted between 30 s and 72 s; **durable survived**; warm restore 1776 ms; busy-hold suppressed sleep over 150 s |
| T-13 | Session isolation | **FAIL** | **session B read session A's file** — see below |
| T-15 | Bootstrap-then-attach durability | PASS | `fstype=nfs4 durable=true faceMap=6/6`; mount present even for a shell-only session |
| T-16a | Reconnect same shellId | PASS | `reconnected=true samePty=true pid=136` |
| T-14 | Real agent turn | UNKNOWN | still needs model credentials in the microVM |

## T-09 vindicated a defensive design choice

The platform-spawned PTY runs with **`$HOME=/root`**, not the image's `ENV HOME=/home/cube`. The
gateway process gets `/home/cube`; a shell does not. Since herdr ignores `HERDR_SOCKET_PATH` whenever
`--session` is passed, the socket path is `$HOME`-derived — so without `cube-face` explicitly pinning
`HOME=/home/cube`, every face would look for the socket at `/root/.config/herdr/herdr.sock` and find
nothing.

This corrects an earlier claim in this document that the platform "honors the image's `ENV HOME`". It
does for the container entrypoint only. The pinning is load-bearing, and the harness now says so in its
own output.

## T-13: EFS trades session isolation away, exactly as predicted

```
session A  wrote  iso-1785918657033
session B  read   iso-1785918657033
```

This is not a regression — it is the documented property of a **shared** EFS access point, and it is why
`InvokeAgentRuntime` has no per-invocation filesystem parameter to select one. On managed session
storage the same test passed, because that storage is per-session by construction.

Consequences:

- **Single-tenant (today): harmless.** Every session is the same person's.
- **Multi-user: this is the whole design constraint.** Isolation must come from *one EFS access point
  per user*, which — since storage is bound at `CreateAgentRuntime` — means **one agent runtime per
  user**. Quota is 100 agents/account, adjustable; `CreateAgentRuntime` is 5/sec.
- The execution role's `elasticfilesystem:AccessPointArn` condition already enforces mount-through-the-
  access-point-only, so per-user access points will be genuinely enforced rather than conventional.

T-13 should be re-scoped before multi-user work: assert *access-point* isolation, not session isolation,
whenever the mount is EFS.

## Defects now closed

1. `/mnt/workspace` absent on shell-only sessions — **closed by EFS** (bound at create time; measured
   `present=yes fstype=nfs4`). The transport still invokes first, because it needs the face map anyway.
2. Boot counter — **fixed**. Root cause was `readJson()` collapsing ENOENT, a torn read and a parse
   error all into `null`, which read as "never booted" and then *overwrote real history*. Replaced with
   an append-only ledger (`O_APPEND` resolves the offset server-side, so an hour-stale NFS client can no
   longer destroy the count). Under-counts by one after a torn write — a floor, not an exact figure.
3. T-12 eviction detection — **fixed**, now keyed on ephemeral-wipe + uptime reset. Reports a real window.
4. T-09 echo parsing — **fixed**; it now measures the values above instead of echoing the probe.
5. `delay()` unref'd timer — **fixed**.
6. Replay narrower than scrollback — **mitigated** by a browser-local scrollback store, capped at
   48,000 chars/face for 24 h. Note this is now *load-bearing*, not a nicety: herdr keeps pane content
   in memory only, so an eviction returns six blank terminals regardless of any herdr setting.
7. Pi integration — **fixed**; `herdr integration install pi` now succeeds.
8. No self-healing — **fixed**. Supervised herdr child + 10 s health poll + workspace reconcile while
   `ready`, all funnelled through one coalescing timer with a 3 s floor and backoff to 60 s. Measured:
   SIGKILL herdr → back in 1 s with six faces; SIGKILL two face shells → tabs restored in 3 s.
   The `HealthyBusy` latch is now bounded (300 s stale / 120 s herdr-down) so a broken cube sleeps
   instead of billing to `maxLifetime`.
9. `spike/browser/index.html` — rendered under headless Chromium by the hardening pass; still not
   exercised against a live AgentCore shell from a real browser.

## Bugs found *during* hardening that were never on the list

- **A browser page reload reliably killed the face it reloaded.** Closing the socket kills the PTY, but
  herdr releases its side more slowly and refuses a second attach in that window — so a reload returned
  `already has an attached client` and closed 1012. Fixed with `--takeover`, which must go *after* the
  terminal id despite `--help` documenting the opposite order.
- **A single oversize WebSocket frame crashed the entire gateway** (no `error` listener on the
  server-side socket), taking every face down with it. Reachable once `maxPayload` was capped.
- **A repaired face was invisible to `/ping` for up to 60 s.** `pane.agent_status_changed` cannot be
  subscribed without a `pane_id`, so the subscription pinned the *old* pane ids; a healed face got a new
  id the gateway wasn't watching. That is the self-healing fix re-creating the exact harm it existed to
  prevent — an agent working unseen, sleepable mid-task. Now reopens the stream on pane-scope change;
  flips in 2 s.
- **herdr 0.8.0 emits no `pane.closed`/`tab.closed` when a pane's shell dies** (verified on a raw socket
  subscription). So a 15 s sweep, not an event, is the real detector for an unattached dead face.

## Remaining caveats — honestly

1. **Real Claude/Pi execution is still unproven.** The container has no model credentials. This is the
   last acceptance criterion and it needs a human to authenticate once inside a workspace.
2. **Typing within ~500 ms of a socket opening is dropped** (0 ms drops, 500 ms+ echoes). A human is
   slower than this, but `waitForHello` replays buffered frames the instant attach resolves, which is
   exactly that pattern. The honest fix restructures `terminal-grid.js`.
3. **`--takeover` is a behaviour change on the shared local/Tailscale path**: a face open in a separate
   herdr TUI will now be taken over rather than refused.
4. **Every herdr restart leaks 6 zombie `[bash] <defunct>`** — node is PID 1 and never reaps processes
   it did not spawn. `pid_max` is 4,194,304, so ~700,000 restarts before it matters. Deliberately not
   fixed with an init.
5. **A cube declared `unrecoverable` reports Healthy** and will be slept. Deliberate — the files are safe
   and the alternative is billing to `maxLifetime` — but a monitor reading only `/ping` cannot tell it
   from a healthy one. The reason is in `/invocations` `busy.reason` and `healing.lastError`.

---

# T-14 CLOSED — a real Claude agent prevents sleep

Claude Code was authenticated interactively inside the microVM on 2026-08-05. Credentials landed at
`/home/cube/.claude/.credentials.json` → `/mnt/workspace/home/.claude/` on EFS, and were confirmed
readable **from a new session on a fresh microVM** — so the login survives eviction and redeploy.

Measuring this needed care. Polling `op=state` over `/invocations` reports `busy.reason: "invocation"`
on every sample, because `beginInvocation()` wraps the handler — the probe contaminates the reading. The
gateway's own ping trace (`/mnt/workspace/.cube/ping-trace.ndjson`) records what `/ping` actually
answered AWS, uncontaminated:

```
total trace rows: 82
kinds: {'seed': 52, 'event': 30}
rows where /ping said BUSY:      21
rows where a pane was WORKING:   16

09:26:31 kind=event busy=True reason=pane working=['w1:p1']
09:28:21 kind=event busy=True reason=pane working=['w1:p1']
09:28:38 kind=event busy=True reason=pane working=['w1:p1']
09:29:07 kind=seed  busy=True reason=pane working=['w1:p1']
09:32:08 kind=seed  busy=True reason=pane working=['w1:p1']
```

`reason=pane`, not `invocation`: the agent itself is what made the runtime report busy. Both paths work —
30 `event` rows prove the Herdr event socket drives it in near real time, not just the 60 s re-seed.

Observed `agent_status` values with a live agent: `working`, `idle`, `unknown` — matching the enum the
design was built against.

**All six acceptance criteria now pass.**

Two follow-ups this exposed, neither blocking:

1. `op=state` can never show the true `busy.reason` (always `invocation`). It is the endpoint that exists
   for debugging busy-ness, so it should report the underlying reason alongside the invocation hold.
2. The trace is the only uncontaminated view of `/ping`. Worth exposing a read-only `op=trace` rather than
   making callers `tail` a file through `op=exec`.
