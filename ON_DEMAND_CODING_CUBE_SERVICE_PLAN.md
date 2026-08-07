# On-Demand Coding Cube Service Plan

**Status:** discovery and UI planning; AgentCore selected for a compatibility spike; no provisioning backend committed  
**Updated:** 2026-08-04  
**Provisioning claims last verified:** 2026-08-04, against AWS documentation, the shipped AgentCore SDKs, and this machine's tooling

## Goal

Offer Coding Cube as a generously provisioned service without assigning every user an always-on $35/month VM. A workspace should feel like a sleeping laptop: selecting it wakes it, its files and Herdr sessions return, and compute billing stops once it sleeps.

That last clause is narrower than it first appears on AgentCore, and the difference is load-bearing: billing stops when the microVM terminates, not when the user stops typing. See **AgentCore cost shape**.

## Non-negotiables

- Coding Cube remains the primary interface; infrastructure is not the product.
- No public inbound ports on workspace compute.
- One user cannot discover or reach another user's shells.
- Never sleep a workspace while a coding agent is working.
- Terminal history, source code, and model credentials stay out of the control-plane database.
- Prefer an existing lifecycle/provisioning platform over a custom control plane.
- A one-command disposable session must cost approximately its active runtime, not a monthly VM fee.

# Frontend and UI Changes

## 1. Turn **Computers** into the workspace switcher

Keep the existing compact Computers popover for switching, not administration.

Each row shows:

- Workspace name
- Repository or purpose, when available
- State: **Ready**, **Working**, **Sleeping**, **Waking**, **Saving**, or **Needs attention**
- Relative activity, such as `active now`, `slept 2h ago`, or `never started`

Selecting a ready workspace switches immediately. Selecting a sleeping workspace starts the wake flow without exposing AWS, containers, regions, or IP addresses.

Add one primary action: **New cloud workspace**.

## 2. Add a focused workspace creation flow

Open a larger sheet or dedicated setup surface from the Computers popover. Do not force provisioning into the existing 360px popover.

Initial fields:

1. **What are you working on?** GitHub repository picker or repository URL.
2. **Workspace name.** Suggested from the repository and editable.
3. **Persistence.**
   - **Workspace** — files and sessions return after sleep.
   - **Quick task** — disposable; removed after the task finishes or times out.
4. **Create workspace.** One primary action.

Hide provider, region, instance type, disk size, VPC, and image selection in the first release. Those are service implementation details, not useful user choices.

## 3. Make wake-up happen inside the Cube

The Cube should remain visible while a workspace wakes. Replace terminal output temporarily with one honest progress surface shared by all six faces:

- `Starting your workspace…`
- `Restoring files…`
- `Resuming Herdr…`
- `Opening terminals…`

Show elapsed time after five seconds. Offer **Cancel** while infrastructure can still be stopped safely. On success, transition directly into the existing terminals without a page reload.

## 4. Make sleep understandable and controllable

Add workspace lifecycle controls to the Computers row or a small workspace-detail surface:

- **Sleep now**
- **Restart**
- **Rename**
- **Delete**

Display the policy in plain language: `Sleeps after 10 minutes with no terminal or agent activity.`

When an agent is working, show `Agent working — sleep paused`. A manual sleep request while an agent is working requires a confirmation that names the running agent.

Do not show a countdown constantly. Show it only near the sleep threshold or when the user asks for workspace details.

## 5. Support quick, disposable work explicitly

A user who wants to run one command should not create a durable machine by accident.

A **Quick task**:

- Starts from the selected repository or base image
- Opens in the normal Cube
- Sleeps quickly when disconnected
- Deletes its filesystem after a clearly stated retention window
- Can be converted to a persistent workspace before deletion

Use `Keep this workspace` rather than infrastructure terms such as snapshot, volume, or archive.

## 6. Add lifecycle states and recovery actions

| State | What the user sees | Primary action |
| --- | --- | --- |
| Ready | Terminals and agent status | Open |
| Working | Agent identity and task status | Open |
| Sleeping | Last activity and retained-work note | Wake |
| Waking | Progress and elapsed time | Cancel |
| Saving | `Saving your workspace before sleep` | Wait |
| Capacity delayed | Honest retry estimate | Keep waiting / Cancel |
| Restore failed | Plain explanation; files remain safe if true | Retry |
| Authentication needed | Which provider needs attention | Reconnect |
| Deleting | Destructive progress; no false completion | None |

Never use an endless spinner without state text, elapsed time, and a recovery action.

## 7. Add a restrained workspace management surface

The first version needs only:

- Workspace list
- Current state
- Last activity
- Approximate active time this month
- Sleep, wake, restart, and delete

Do not build a generic cloud dashboard, billing dashboard, instance catalog, card grid, or team administration UI yet.

## 8. First-run experience

1. Sign in with GitHub or another standard OIDC provider.
2. Choose a repository.
3. Create a workspace.
4. Watch it wake inside the Cube.
5. Authenticate Claude/Pi only when first needed, using their standard device or OAuth flow.

The interface should explain that model credentials live inside the user's workspace and are not stored by Coding Cube.

## 9. Accessibility and responsive behavior

- Preserve keyboard, touch, and direct terminal access.
- Announce lifecycle changes through an `aria-live` region without repeatedly interrupting terminal input.
- Do not encode states by color alone.
- Keep progress and management usable at 320px width.
- Respect reduced motion; wake transitions become immediate state swaps.
- Keep focus on the workspace row or initiating action after failures.

# Provisioning Research

## Shortlist

| Option | Uses AWS credits | Scale-to-zero model | Persistence | Fit |
| --- | --- | --- | --- | --- |
| **Amazon Bedrock AgentCore Runtime** | Yes | Dedicated microVM sessions stop automatically after configurable idle time | Per-session managed storage (Preview, 1 GB, wiped on every redeploy) or customer-managed EFS/S3 Files (shared across sessions) | Best first candidate; purpose-built for this exact workload |
| **Cloudflare Sandbox SDK** | No | Containers sleep automatically; billed in 10ms increments | Ephemeral disk plus explicit R2 backups/restores | Best independent benchmark |
| **Daytona** | Possibly through BYOC | Auto-stop, pause, archive, and delete | Snapshots; stopped/paused/archived states | Strong managed option; BYOC terms need confirmation |
| **Coder Community** | Yes | Stops workspace compute through Terraform | Official AWS template stops EC2 and retains its disk | Useful fallback for conventional long-lived dev machines |
| **Direct ECS Fargate** | Yes | Runs tasks only while active | EFS or object-storage restore | Lower-level fallback only |

## Amazon Bedrock AgentCore Runtime

AgentCore Runtime is now the strongest AWS-native fit. It runs each user session in a dedicated isolated microVM, accepts a custom container image, supports OAuth or IAM at the boundary, bills actual CPU and peak memory per second, and automatically terminates idle compute. The same session ID starts fresh compute again when the user returns.

Its interactive shell API is unusually close to Coding Cube's requirements:

- PTY-backed WebSocket terminal sessions, binary-framed, with caller-supplied stable shell IDs — so `face-1` through `face-6` are legal and a reload reclaims a face rather than doubling it
- Reconnection using the same session and shell IDs, with up to 256KB of replayed output
- Configurable idle timeout from 60 seconds to 8 hours, defaulting to 15 minutes
- Explicit busy health reporting so a working agent can prevent idle termination
- Up to 10 concurrent shells — but whether that ceiling is scoped to the runtime resource or to a single runtime session is genuinely unresolved in AWS's own documentation, and the answer decides whether one runtime serves many users or exactly one
- Eight-hour maximum microVM lifetime; the platform reprovisions, but it restores the filesystem, not the processes

The shells are a platform feature, not something the container implements. That is new since this plan was first written and it changes the shape of the work — see **AgentCore terminal transport**.

Managed session storage persists a private workspace across stop/resume and currently expires after 14 idle days. It is still Preview, it is capped at 1 GB and roughly 100,000–200,000 files with none of those limits adjustable, and it is wiped whenever the agent runtime version is updated — that is, on every image redeploy. EFS and S3 Files are the stable alternatives, but they are bound at `CreateAgentRuntime` time rather than per invocation and are documented as shared across sessions and agents, so they do not provide per-user isolation on their own. See **AgentCore persistence**.

AgentCore does not map users to session IDs or impose per-user quotas; a small authenticated control API still owns that relationship. It has to: there is no IAM condition key for session ID, so a JWT authorizer validates a token without being able to stop that token from naming any other user's session. The only browser path where authorization is actually enforceable is a server-side SigV4 presigned URL, which binds identity to a specific session and shell at mint time and expires in at most 300 seconds.

At current public pricing, Runtime charges $0.0895 per consumed vCPU-hour and $0.00945 per GB-hour of peak memory, measured per second with a one-second minimum. Those rates are confirmed. The utilization assumption behind them was wrong and is corrected under **AgentCore cost shape**. AWS credits apply.

## Cloudflare Sandbox SDK

Cloudflare supplies a similar runtime surface: isolated containers, automatic sleep, shell sessions, browser terminal WebSockets, and point-in-time directory backups to R2. Documented cold starts are commonly 1–3 seconds, and billing stops after sleep.

It remains the best comparison if AgentCore's container, storage, or terminal contract blocks Herdr. It should not be adopted merely because its API looks convenient before testing the AWS primitive that consumes existing credits.

## Daytona

Daytona exposes sub-90ms sandbox creation, PTYs, snapshots, warm pools, auto-stop, VM pause/resume, archive, and per-second billing. Its BYOC model deploys custom regions to Kubernetes through Helm and appears to require a commercial relationship. Request terms only if both AgentCore and Cloudflare fail the compatibility spike.

## Coder

Coder remains a good conventional cloud-development control plane, but it solves a broader problem than Coding Cube currently needs. Its official AWS template stops persistent EC2 instances, which removes compute charges but leaves slower VM wake-up and EBS storage per user. Some enforced idle controls are Premium. Use Coder if users ultimately need durable general-purpose machines rather than serverless agent sessions.

## Rejected for now

- **DevPod:** client-only; no hosted identity or multi-user orchestration.
- **E2B self-hosting:** beta AWS support plus Nomad, Firecracker artifacts, and large nested-virtualization workers.
- **Raw Kubernetes/Karpenter:** a cluster and operator stack before product fit.
- **Custom ECS control plane:** Fargate compute is suitable, but lifecycle, terminal routing, identity, quotas, and repair would become our code.

# Recommended Path

## Decision

Test **AgentCore Runtime first**. It is the modern AWS primitive we were looking for and makes a Coder deployment unnecessary unless the test finds a hard blocker.

Only benchmark Cloudflare Sandbox if AgentCore fails on wake latency, Herdr restoration, interactive terminal fidelity, container restrictions, or storage safety. Keep Daytona and Coder as fallbacks rather than parallel integrations.

Most of that test costs nothing. Herdr on linux/arm64, the six-pane bootstrap, restore after a restart, the busy health logic, and the image size are all container-internal and provable on a laptop with no AWS resources and no spend. Two local installs are required first and neither is on this machine yet: AWS CLI v2 at 2.34.16 or later, and a `linux/arm64` container builder. The same image is also what a Cloudflare Sandbox comparison would run, so the container work survives every outcome.

## AgentCore lifecycle

1. **Active:** one isolated microVM serves the user's Coding Cube session.
2. **Idle:** the microVM remains warm and its memory is billed continuously. The published CPU exemption is conditioned on no background process running, which a cube holding six Herdr panes does not satisfy.
3. **Stopped:** idle timeout ends the microVM and every process in it; the session ID and mounted files remain.
4. **Resuming:** the next request creates fresh compute and restarts Herdr from persistent state. Nothing in memory carries over.
5. **Expired/disposable:** retention deletes session storage and its user mapping.

The first spike should use a short idle timeout so the complete sleep/resume cycle can be tested repeatedly. Production can begin around 10 minutes, with Herdr reporting busy while any agent is working.

Reporting busy is precise, not approximate: the health response carries an optional `time_of_last_update` that must be written only when the status actually changes. A timestamp that advances on every ping reads to the platform as continuous change, and the idle timeout then never fires — sessions run to the eight-hour ceiling and bill the whole way.

## AgentCore terminal transport

This plan originally assumed the only way to get six shells into a browser was a custom PTY gateway inside the container. That is no longer the only option, and the two paths have different risk profiles.

**Native interactive shells.** `InvokeAgentRuntimeCommandShell` is a platform-provided, PTY-backed terminal over WebSocket. The container needs no terminal code at all; its job shrinks to health, invocations, and Herdr bootstrap. The browser connects directly with no proxy. The operational envelope is documented and binding: 64KB maximum frame, 250 frames per second, one-hour maximum connection duration, binary frames only, close code 4000 when another client claims the same shell ID. One caveat on that first number — this account's Service Quotas registers a 32KB WebSocket frame size, which disagrees with the documented 64KB, and it is unverified which governs. The byte-level framing is not documented at all: AWS publishes a developer-guide page but no API reference for this operation, and the wire format was read out of two shipped AWS clients that agree byte for byte. There is no AWS SDK for JavaScript support, so the browser client is hand-written.

**Custom PTY gateway over `/ws`.** The container serves its own WebSocket on port 8080 and AgentCore passes the stream through. Fully specified, language-agnostic, and the code already exists in this repository. Its frame limit is 32KB rather than 64KB, and it is unverified whether arbitrary query parameters survive the proxy — a client hello frame removes that dependency.

The fallback ladder, in order:

1. Native interactive shells.
2. The `/ws` passthrough with the existing gateway.
3. The same container image on Cloudflare Sandbox, with only the outer transport swapped.

The container is identical under all three, so the container work is not wasted under any outcome.

Two prerequisites apply to the native path regardless of anything else. The runtime must set `metadataConfiguration.requireMMDSV2 = true`, mandatory for agent runtimes since 2026-06-30, or every shell connection fails. And the agent must have been created after 2026-06-05; a newly created runtime qualifies.

Region availability for this specific operation is unverified. Interactive shells are generally available, every AWS example uses us-west-2, and the regions page has no per-API row — but the predecessor shell-command API is explicitly GA in us-east-1 and a dated third-party report shows interactive shells working there. One connection attempt settles it; a pre-emptive relocation is not warranted.

## AgentCore concurrency

The most consequential open question in this plan. AWS states a ceiling of 10 concurrent shells and is inconsistent about what it is a ceiling *on*: four statements across two documentation pages plus the launch announcement say "per runtime", meaning the runtime resource, and one release-note line says "per runtime session". The evidence runs five to one toward per-resource. There is no Service Quotas path to raise it — the account registers only a request-rate quota for this operation and no concurrency quota of any kind.

If it is per-session, six faces of ten is comfortable. If it is per-resource, one AgentCore runtime serves exactly one concurrent Coding Cube user. The fallback is one runtime per user — the account limit is 1,000 agents and is adjustable — but `CreateAgentRuntime` is a 5 TPS control-plane call requiring a wait for `READY`, so it cannot sit on the login path. That implies a warm pool of pre-created runtimes, which reintroduces exactly the always-on cost this migration exists to remove.

Two details that matter under either reading. Detached shells still count toward the ceiling, and a browser reload that mints fresh shell IDs would momentarily need twelve, so shell IDs must be deterministic per face. And the six-face grid is not the whole surface: `src/server/terminal-grid.js` already accepts four slots per face, a 24-PTY addressable space, which does not fit ten under either reading.

## AgentCore persistence

**Managed session storage.** Isolation is per session and service-enforced, with no VPC and no additional IAM permissions — that part is genuinely good, and it is the only option that gives per-user isolation for free. The costs are: 1 GB per session and roughly 100,000–200,000 files, neither adjustable, where the file ceiling is really a 50MB metadata budget that a single `node_modules` tree can exhaust well before the byte cap. No hard links, no extended attributes, no `fallocate`, and no device files, FIFOs, or UNIX sockets, which means a socket-based tool cannot keep its socket on the mount. Permissions are stored but not enforced. Data is deleted after 14 days without invocation. And it is wiped whenever the agent runtime version is updated.

That last point belongs in the risk framing, not a footnote: **every image redeploy destroys every session's files and Herdr conversations.** A service that ships weekly would reset every user's workspace weekly. Whether pinning an endpoint to a specific runtime version avoids the wipe is expressible in the API but unverified, and it should not be relied on. Which kinds of update bump the version — an image change certainly, an environment-variable-only change unknown — is also unverified. It is Preview.

**Per-user EFS or S3 Files access points.** This plan listed these as the stable per-user alternative. That needs correcting. Filesystem configurations are bound at `CreateAgentRuntime` time, not selected per invocation, and both bring-your-own options are documented as "shared — multiple sessions and agents access the same data". There is no documented way to choose a per-user access point when invoking a session. Per-user isolation on EFS or S3 Files therefore implies **one agent runtime per user**, which is the same warm-pool problem the concurrency question raises, arrived at from a different direction.

They also cost more to operate: `networkMode: VPC`, outbound TCP 2049 to the mount targets, mount targets sharing at least one Availability Zone with the runtime subnets, same-account only, access-point POSIX UID/GID matched to the container's user, and a 30-second mount timeout where any single failure fails the whole invocation with HTTP 424.

So the honest position is that there is no persistence path today that is simultaneously per-user, durable across redeploys, and cheap to operate. The alpha picks two.

## AgentCore cost shape

The per-unit rates in this plan are correct: $0.0895 per vCPU-hour and $0.00945 per GB-hour, metered per second with a one-second minimum. The utilization assumption around them was not.

Memory is billed for the entire session, from microVM boot through initialization, active processing, and **idle**, until termination. The "you only pay when working" reading applies to CPU only, and even that carries the condition "if no other background process is running". A cube holding six Herdr panes plus Claude Code has background processes by definition, so neither half of the cheap-idle assumption survives contact with this workload.

Model the cost as GB-hours from microVM boot to microVM termination. Six shells idle at roughly 2 GB is about $0.02 per hour, which is negligible for a spike and is not negligible multiplied by users and by a 15-minute idle timeout. The idle threshold is now a direct cost lever rather than a convenience setting, and it trades against a cold start whose length is still unmeasured.

Managed session storage pricing is unverified — the announcement carries no pricing statement.

## AgentCore hard ceilings

Two ceilings are absolute and both are visible to the user.

**Eight-hour maximum session lifetime**, not extendable, with a 15-minute default idle timeout under it. When either fires, the microVM is destroyed and every process in it dies. Resume provisions a brand-new microVM and restores the filesystem only. The always-on-box mental model does not carry over: a long-lived terminal attach does not survive, and continuity comes from Herdr session restoration rather than from process memory. The interface should treat "your workspace restarted" as an ordinary daily event with an honest progress surface, not as a failure state.

**One-hour maximum WebSocket connection**, force-closed with a specific close code. Reconnecting with the same shell ID is a normal operating condition, not an error path, and it happens on all six faces. Only 256KB of scrollback replays on reconnect; anything beyond that is lost unless the frontend buffers it. Separately, a shell left quiet for roughly 15 minutes is dropped unless the client sends its own heartbeat, because browsers cannot send WebSocket ping frames.

A third, smaller ceiling has the same shape: presigned URLs expire in at most 300 seconds, so whatever mints them is on the reconnect path continuously, not just at first connect.

## AgentCore spike acceptance criteria

- Deploy the existing Node, Herdr, Claude, and Pi stack in a custom AgentCore container, under the hard 2 GB image cap.
- Use one runtime session and six concurrent interactive shells.
- **Establish whether the 10-shell ceiling is per runtime session or per runtime resource.** Nothing else in this section is worth building until that is known.
- Record the platform-spawned shell's identity — binary, uid, `HOME`, `TERM`, working directory — all four of which are undocumented.
- Run real commands and one real Claude/Pi session through Coding Cube.
- Persist the repository and Herdr session across forced runtime stop/resume.
- Confirm a working agent's busy health prevents idle shutdown, and that the health timestamp only moves on real status changes.
- Reconnect all six faces without copied addresses or pairing codes, including across the one-hour connection ceiling.
- Measure cold wake time, shell replay, storage behavior, and actual AWS cost.
- Prove two session IDs cannot read each other's files or shells.
- Identify a non-Preview persistence path before production, or explicitly accept Preview risk for an alpha — including that a redeploy resets every workspace.

The spike is specified in `spike/README.md`, ordered so that everything provable without AWS is proved first.

# Delivery Order

1. Run the smallest AgentCore compatibility spike; do not build a product control plane.
2. Record wake time, sleep behavior, shell fidelity, Herdr restoration, isolation, and cost.
3. If it passes, define the tiny UI/API contract: list, create, wake, sleep, delete, and state events.
4. Implement the frontend lifecycle states against fake data.
5. Connect the UI to a minimal authenticated AgentCore session mapper. It also mints per-face presigned WebSocket URLs, because the browser cannot authenticate itself and no AWS-side check binds a session to a user.
6. Benchmark Cloudflare only for any criterion AgentCore fails.
7. Add quotas, teams, billing, regions, and machine choices only when real usage requires them.

# Open Decisions

Blocking, in the sense that the architecture cannot be chosen without them:

- **Is the 10-concurrent-shell ceiling scoped to the runtime resource or to a runtime session?** AWS's own pages contradict each other, five statements to one in favour of per-resource, and there is no quota-increase path. Per-resource means one concurrent user per runtime and forces either one runtime per user with a warm pool, or the `/ws` passthrough transport. Only a live test answers it.
- If it is per-resource, which fallback: a warm pool of per-user runtimes, or the passthrough gateway? The first reintroduces always-on cost; the second gives up a platform feature that already works.
- Managed session storage is wiped on every agent runtime version update. Is a workspace reset per redeploy acceptable for an alpha, and if not, what replaces it? The per-user EFS answer this plan previously assumed does not exist as such — bring-your-own filesystems are bound to the runtime and shared across sessions, so per-user isolation there means one runtime per user.

Open, but not blocking:

- Is the default a persistent workspace or a disposable quick task?
- Is 10 minutes still the right idle threshold, now that memory bills continuously through idle and the wake cost is a cold start of unmeasured length?
- Does the cube ever need more than six shells? The server already accepts four slots per face, and 24 exceeds the shell ceiling under either reading of it.
- Where does the presigned-URL minter live, and what does it check? It is on the reconnect path for six faces at least every 300 seconds, and it is the only place session-to-user authorization can be enforced.
- How is a forced restart at the eight-hour ceiling presented? It is not an error, it is not rare, and it will interrupt work in progress.
- How long should archived workspaces be retained while credits remain generous?
- Will model authentication use user-owned provider accounts, AgentCore Identity, included Bedrock capacity, or a combination?
- Live process memory is settled — nothing survives a stop. The remaining question is whether Herdr session restoration, including pane history, is a good enough substitute in practice.

# Sources

Verified 2026-08-04. Every AgentCore claim above was checked against the page listed here, and where the pages disagree with each other that is said so in the text rather than resolved silently.

- [AgentCore Runtime overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html)
- [AgentCore interactive shells](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-command-shell.html)
- [AgentCore HTTP protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)
- [AgentCore WebSocket protocol](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html)
- [AgentCore session lifecycle](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
- [AgentCore lifecycle configuration](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)
- [AgentCore filesystem configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)
- [AgentCore quotas and limits](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)
- [AgentCore troubleshooting](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-troubleshooting.html)
- [AgentCore harness environment](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-environment.html)
- [AgentCore supported regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html)
- [CreateAgentRuntime API reference](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateAgentRuntime.html)
- [AWS::BedrockAgentCore::Runtime CloudFormation resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-runtime.html)
- [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)
- [Session storage public preview announcement, 2026-03-25](https://aws.amazon.com/about-aws/whats-new/2026/03/bedrock-agentcore-runtime-session-storage/)
- [Shell command execution GA, including us-east-1](https://aws.amazon.com/about-aws/whats-new/2026/03/bedrock-agentcore-runtime-shell-command/)
- [Interactive shells announcement, 2026-06-05](https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-agentcore-runtime/)

Verified against shipped software rather than documentation, because the documentation does not cover it:

- `bedrock-agentcore` 1.20.0 (Python) and `@aws/agentcore` 0.26.0 (npm) — the interactive-shell URL and binary wire format, read from both and confirmed byte-for-byte identical. AWS publishes no API reference for this operation.
- `@aws-sdk/client-bedrock-agentcore` 3.1103.0 — contains no interactive-shell command; confirmed by unpacking the published tarball.
- AWS CLI v2 changelog — `filesystemConfigurations` added in 2.34.16, bring-your-own S3 Files and EFS in 2.34.44. The CLI installed on this machine is 2.33.15 and cannot express either.
- Service Quotas for this account in us-east-1 — one request-rate quota for the shell operation and no concurrency quota of any kind.

Explicitly unverified, and treated as such above: the region status of the interactive-shell operation specifically; whether pinning an endpoint to a runtime version preserves session storage across a redeploy; which kinds of runtime update bump the version; managed session storage pricing; the uid, `HOME`, shell binary, and `TERM` of a platform-spawned shell; whether the documented 64KB frame size or the account's 32KB quota entry governs; and whether the 10-shell ceiling is per session or per resource.

Reviewed 2026-08-04 for the comparison shortlist, not re-verified in the AgentCore pass:

- [Coder repository and overview](https://github.com/coder/coder)
- [Coder workspace lifecycle](https://coder.com/docs/user-guides/workspace-lifecycle)
- [Coder workspace scheduling](https://coder.com/docs/user-guides/workspace-scheduling)
- [Coder resource persistence](https://coder.com/docs/admin/templates/extending-templates/resource-persistence)
- [Coder web IDEs and apps](https://coder.com/docs/admin/templates/extending-templates/web-ides)
- [Coder AWS Linux template](https://github.com/coder/registry/tree/main/registry/coder/templates/aws-linux)
- [Cloudflare Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)
- [Cloudflare Sandbox terminal API](https://developers.cloudflare.com/sandbox/api/terminal/)
- [Cloudflare Sandbox backups](https://developers.cloudflare.com/sandbox/api/backups/)
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Cloudflare Containers architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)
- [Daytona sandboxes and lifecycle](https://www.daytona.io/docs/en/sandboxes/)
- [Daytona BYOC](https://www.daytona.io/docs/en/bring-your-own-compute/)
- [Daytona pricing](https://www.daytona.io/pricing)
- [DevPod repository](https://github.com/loft-sh/devpod)
- [E2B self-hosting guide](https://github.com/e2b-dev/infra/blob/main/self-host.md)
- [AWS EC2 instance lifecycle and billing](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html)
- [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/)
