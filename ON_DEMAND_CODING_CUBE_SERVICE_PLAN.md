# On-Demand Coding Cube Service Plan

**Status:** discovery and UI planning; no provisioning backend selected yet  
**Updated:** 2026-08-04

## Goal

Offer Coding Cube as a generously provisioned service without assigning every user an always-on $35/month VM. A workspace should feel like a sleeping laptop: selecting it wakes it, its files and Herdr sessions return, and compute billing stops when neither the user nor an agent is working.

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
| **Amazon Bedrock AgentCore Runtime** | Yes | Dedicated microVM sessions stop automatically after configurable idle time | Per-session managed storage or customer-managed EFS/S3 Files | Best first candidate; purpose-built for this exact workload |
| **Cloudflare Sandbox SDK** | No | Containers sleep automatically; billed in 10ms increments | Ephemeral disk plus explicit R2 backups/restores | Best independent benchmark |
| **Daytona** | Possibly through BYOC | Auto-stop, pause, archive, and delete | Snapshots; stopped/paused/archived states | Strong managed option; BYOC terms need confirmation |
| **Coder Community** | Yes | Stops workspace compute through Terraform | Official AWS template stops EC2 and retains its disk | Useful fallback for conventional long-lived dev machines |
| **Direct ECS Fargate** | Yes | Runs tasks only while active | EFS or object-storage restore | Lower-level fallback only |

## Amazon Bedrock AgentCore Runtime

AgentCore Runtime is now the strongest AWS-native fit. It runs each user session in a dedicated isolated microVM, accepts a custom container image, supports OAuth or IAM at the boundary, bills actual CPU and peak memory per second, and automatically terminates idle compute. The same session ID starts fresh compute again when the user returns.

Its interactive shell API is unusually close to Coding Cube's requirements:

- WebSocket terminal sessions
- Up to 10 concurrent shells per runtime, enough for all six faces
- Reconnection using the same session and shell IDs
- Up to 256KB of replayed output after reconnect
- Configurable idle timeout from 60 seconds to 8 hours
- Eight-hour maximum microVM lifetime followed by transparent reprovisioning
- Explicit busy health reporting so a working agent can prevent idle termination

Managed session storage persists a private workspace across stop/resume and currently expires after 14 idle days. It is still Preview. Stable alternatives are EFS or S3 Files mounts, but their access-point isolation must be designed carefully. AgentCore does not map users to session IDs or impose per-user quotas; a small authenticated control API still owns that relationship.

At current public pricing, Runtime charges $0.0895 per consumed vCPU-hour and $0.00945 per GB-hour of peak memory, measured per second with a one-second minimum. CPU waiting on model or network I/O is not charged when no background process is using it. AWS credits apply.

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

## AgentCore lifecycle

1. **Active:** one isolated microVM serves the user's Coding Cube session.
2. **Idle:** the microVM remains briefly warm; memory is still billed but unused CPU is not.
3. **Stopped:** idle timeout ends the microVM; the session ID and mounted files remain.
4. **Resuming:** the next request creates fresh compute and restarts Herdr from persistent state.
5. **Expired/disposable:** retention deletes session storage and its user mapping.

The first spike should use a short idle timeout so the complete sleep/resume cycle can be tested repeatedly. Production can begin around 10 minutes, with Herdr reporting busy while any agent is working.

## AgentCore spike acceptance criteria

- Deploy the existing Node, Herdr, Claude, and Pi stack in a custom AgentCore container.
- Use one runtime session and six concurrent interactive shells.
- Run real commands and one real Claude/Pi session through Coding Cube.
- Persist the repository and Herdr session across forced runtime stop/resume.
- Confirm a working agent's busy health prevents idle shutdown.
- Reconnect all six faces without copied addresses or pairing codes.
- Measure cold wake time, shell replay, storage behavior, and actual AWS cost.
- Prove two session IDs cannot read each other's files or shells.
- Identify a non-Preview persistence path before production, or explicitly accept Preview risk for an alpha.

# Delivery Order

1. Run the smallest AgentCore compatibility spike; do not build a product control plane.
2. Record wake time, sleep behavior, shell fidelity, Herdr restoration, isolation, and cost.
3. If it passes, define the tiny UI/API contract: list, create, wake, sleep, delete, and state events.
4. Implement the frontend lifecycle states against fake data.
5. Connect the UI to a minimal authenticated AgentCore session mapper.
6. Benchmark Cloudflare only for any criterion AgentCore fails.
7. Add quotas, teams, billing, regions, and machine choices only when real usage requires them.

# Open Decisions

- Is the default a persistent workspace or a disposable quick task?
- Is 10 minutes the right idle threshold for conversational coding agents?
- How long should archived workspaces be retained while credits remain generous?
- Is AgentCore managed session storage safe enough while it remains Preview, or should the alpha use per-user EFS/S3 Files access points?
- Will model authentication use user-owned provider accounts, AgentCore Identity, included Bedrock capacity, or a combination?
- Is preserving live process memory important, or is Herdr session restoration sufficient?

# Sources

Reviewed 2026-08-04:

- [AgentCore Runtime overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html)
- [AgentCore interactive shells](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-command-shell.html)
- [AgentCore session lifecycle](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
- [AgentCore lifecycle configuration](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)
- [AgentCore filesystem configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)
- [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)
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
