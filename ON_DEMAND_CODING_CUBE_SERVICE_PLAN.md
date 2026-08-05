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
| **Coder Community** | Yes | Stops workspace compute; Terraform controls what persists | Official AWS template stops EC2 and retains its disk | Best AWS-first control-plane candidate |
| **Cloudflare Sandbox SDK** | No | Containers sleep automatically; billed in 10ms increments | Ephemeral disk plus explicit R2 backups/restores | Best speed/UX benchmark |
| **Daytona** | Possibly through BYOC | Auto-stop, pause, archive, and delete | Snapshots; stopped/paused/archived states | Best managed sandbox candidate; BYOC terms need confirmation |
| **DevPod** | Yes | Provider-specific automatic shutdown | Provider-specific | Excellent client tool, not a multi-user service control plane |
| **E2B self-hosted** | Yes, beta | Firecracker sandbox fleet | Snapshots | Too operationally heavy for the first version |
| **Direct ECS Fargate** | Yes | Run a task only while active | EFS or explicit object-storage restore | Viable fallback, but would require building the missing control plane |

## Coder

Coder is an AGPL-3.0 self-hosted cloud-development control plane with users, templates, APIs, Terraform provisioners, workspace lifecycle, secure agent networking, browser terminals, and generic `coder_app` reverse proxies. Its Community tier currently advertises unlimited workspaces, templates, and members in one organization plus OIDC.

The official AWS Linux template already models the laptop behavior: `aws_ec2_instance_state` switches the EC2 instance between `running` and `stopped`. AWS does not bill stopped instance compute, although EBS storage remains billed. Coder templates can also destroy ephemeral compute while retaining a separate persistent resource.

A Coding Cube gateway can run as a `coder_app`, allowing Coder's authenticated agent tunnel to proxy its loopback HTTP and WebSocket traffic. That could replace our custom Tailscale/pairing path for managed users while retaining Tailscale for self-hosted users.

**Known caveat:** some enforced inactivity and governance features are Premium. Confirm exactly which activity-based shutdown controls are available under Community and whether offering a hosted service under the AGPL license fits the intended business before committing.

## Cloudflare Sandbox SDK

Cloudflare now supplies much of the exact runtime surface: isolated containers, configurable automatic sleep, Worker-controlled lifecycle, shell sessions, browser terminal WebSockets, and point-in-time directory backups to R2. Container cold starts are documented as commonly 1–3 seconds.

Containers are billed every 10ms while running and stop billing after sleep. The Workers Paid plan includes an initial memory, CPU, and disk allowance. The tradeoff is that container disk is ephemeral after sleep, so Coding Cube must create and restore backups rather than assuming a durable local disk.

This is likely the smallest polished product implementation, but it does not consume AWS credits.

## Daytona

Daytona exposes sub-90ms container sandbox creation, PTYs, snapshots, warm pools, auto-stop, VM pause/resume, archive, and per-second billing. Archived container sandboxes are documented as consuming no reserved-resource billing. Its BYOC feature runs custom regions on the customer's Kubernetes infrastructure through Helm charts.

It is a strong match, but the current public repository is not a straightforward self-hostable control plane and BYOC appears to require a commercial relationship. Request BYOC pricing and licensing before designing around it. Daytona also advertises separate startup credits, which may make its hosted service cheaper than spending engineering time merely to use AWS credits.

## Rejected for now

- **DevPod:** intentionally client-only; it does not solve hosted identity, quotas, or multi-user orchestration.
- **E2B self-hosting:** AWS support is beta and its documented stack includes Nomad, Firecracker artifacts, Cloudflare configuration, and large nested-virtualization workers such as `m8i.4xlarge`. This recreates an infrastructure team.
- **Raw Kubernetes/Karpenter:** powerful but adds a cluster, operators, storage policy, networking, and user isolation before proving the product.
- **Custom ECS control plane:** Fargate's per-second billing and one-minute minimum are attractive, but auth, lifecycle, activity detection, persistence, terminal proxying, quotas, and repair would all become our code.

# Recommended Path

## Decision

Do not build a bespoke multi-user provisioner yet. Run two compatibility spikes behind the same Coding Cube UI contract:

1. **AWS/Coder spike:** Coder Community plus its official AWS lifecycle and Coding Cube as a `coder_app`.
2. **Fast-sandbox spike:** Cloudflare Sandbox SDK; optionally Daytona if BYOC/commercial terms are favorable.

Choose from measured wake time, reliable Herdr restoration, true idle cost, licensing, and implementation size—not from cloud credits alone.

## AWS-first lifecycle

Use four resource states:

1. **Running:** EC2 or Fargate compute is billed; Herdr and agents run.
2. **Sleeping:** compute is stopped; a small persistent disk remains. Selecting the workspace starts it.
3. **Archived:** idle long enough that only a compressed snapshot/object backup remains.
4. **Disposable:** quick-task data is deleted after its retention window.

A stopped EC2 instance has no instance compute charge. A 10GB gp3 workspace disk is roughly a small sub-dollar monthly storage cost in common US regions, rather than the approximately $25–35/month cost of an always-running `t4g.medium`. Archiving long-idle workspaces reduces even that storage floor.

Suggested defaults for the spike:

- Sleep after 10 minutes with no terminal connection **and** no working agent.
- Archive after 7 days asleep.
- Delete disposable sessions after 24 hours.
- Never sleep merely because the browser closed while an agent remains working.

These are reversible product defaults, not final policy.

## Coder spike acceptance criteria

- A user signs in through standard OIDC.
- Creating a workspace provisions one isolated AWS resource.
- No workspace has a public inbound port.
- Coder proxies the loopback Coding Cube gateway, including terminal WebSockets.
- A sleeping workspace incurs no EC2 compute charge.
- Selecting it wakes and reconnects without an address or pairing code.
- Herdr restores all six faces and resumes a real Claude/Pi session.
- A working agent prevents automatic sleep.
- Deleting a workspace removes compute, storage, credentials, and proxy routes.
- Wake, sleep, and restore durations are recorded rather than guessed.

# Delivery Order

1. Build the frontend lifecycle states with fake data behind the Computers panel.
2. Define a tiny provider-neutral UI contract: list, create, wake, sleep, restart, delete, and state events.
3. Run Coder and Cloudflare/Daytona spikes against that contract.
4. Select one backend and replace the fake adapter.
5. Add quotas, retention controls, and operational recovery only after real usage.
6. Add teams, sharing, billing, multiple regions, and machine-size choices only when demanded.

# Open Decisions

- Is the default a persistent workspace or a disposable quick task?
- Is 10 minutes the right idle threshold for conversational coding agents?
- How long should archived workspaces be retained while credits remain generous?
- Do Coder Community's license and lifecycle features cover a hosted public service?
- Will model authentication use user-owned provider accounts, included Bedrock capacity, or both?
- Is preserving live process memory important, or is Herdr session restoration sufficient?

# Sources

Reviewed 2026-08-04:

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
