# Multi-user Coding Cube

**Status:** infrastructure written, nothing deployed. Every script in `infra/aws/` and
`spike/aws/create-user-workspace.sh` prints a plan, refuses on the wrong account, demands a
typed confirmation and prints its own teardown. None of them has been run.

The single-operator path is unchanged and stays unchanged: `spike/mint-server.mjs` on
loopback, local and Tailscale hosts as they are today. This is additive.

---

## The constraint that shapes everything

EFS access points are **shared across all sessions of a runtime**. This was measured, not
assumed — `spike/RESULTS.md`, T-13:

```
session A  wrote  iso-1785918657033
session B  read   iso-1785918657033
```

Storage binds at `CreateAgentRuntime` time. `InvokeAgentRuntime` has no per-invocation
filesystem parameter, and there is no way to select a different access point per session.
So the only place in the API where a different access point can be chosen is a **different
agent runtime**.

> **One EFS access point and one agent runtime per user.** Not caution — the only shape the
> API permits.

Three things follow immediately:

1. **The agent-runtime quota is the ceiling on registered users.** 100 per account, adjustable.
2. **Provisioning a user is a real AWS operation**, not a row in a table. Hence invite-only
   signup: self-service registration would let a stranger exhaust the quota.
3. **The isolation is enforceable rather than conventional.** Each user's execution role
   carries `elasticfilesystem:AccessPointArn` scoped to exactly one access point, so it can
   mount only through that one — a shared role would have to name every access point (or a
   wildcard) and the guarantee would evaporate.

### The gap in that argument, and how it is closed

The paragraph above is airtight for mounts **the platform performs**. It says nothing about
mounts performed **from inside the microVM**, and there the picture is worse:

- the container runs as **uid 0** (measured, T-09),
- it sits in the same VPC and security group as the EFS mount targets,
- that security group allows 2049 within itself — which is what makes the platform's own
  mount work in the first place,
- and by default EFS has **no file system policy**, so an NFS client that can reach a mount
  target is authorised by POSIX permissions alone, with root not squashed.

So `mount -t nfs4 <mount-target>:/ /mnt/everyone` from one user's cube would expose every
other user's `/workspaces/<sub>`. Mode `0700` does not help against a process that is root.

`infra/aws/harden-efs.sh` attaches a file system policy that denies any request carrying no
`elasticfilesystem:AccessPointArn` context key. A raw NFS mount carries none; the platform's
access-point-scoped mount carries one.

**This is reasoned, not measured.** The rest of this repository draws that line hard, so it
is drawn here too. The script prints the two-sided experiment that would settle it — the
legitimate mount must still work, the raw mount must now fail — and a `--rollback` for when
it does not. Do it before there is a second user, not after.

### What is deliberately *not* isolated

- **Two sessions of the same user share one workspace.** Correct: it is their workspace.
  T-13 should be re-scoped from "session isolation" to "access-point isolation" — the
  original test now asserts something the design does not claim.
- **The container image is shared.** One `coding-cube-spike:v2` for everyone.
- **The NAT gateway is shared**, so every user's cube egresses from one IP. One user
  hammering an API can get the shared address rate-limited for everyone.
- **Model credentials live in the workspace** (`/mnt/workspace/home/.claude/`), so each user
  authenticates their own agent once, inside their own cube, and it survives eviction and
  redeploy. Nobody's credentials touch the control plane.

---

## Why the control plane mints server-side

A browser cannot authenticate to AgentCore. SigV4 needs headers a WebSocket upgrade cannot
carry, and presigned URLs live at most 300 seconds — so something server-side has to sign one
per face per reconnect.

The obvious alternative is `customJWTAuthorizer` on the runtime, letting the browser present
its Cognito token straight to AgentCore. **That is not securable**, and this was checked
against the docs and the botocore model rather than guessed:

- AgentCore enforces **no mapping between a token and a `runtimeSessionId`**.
- There is **no IAM condition key for the session id**.

Any valid token could therefore name any session. Presigning is the only place identity can
be bound to a target, so it is the only design available. Do not revisit this.

---

## The pieces

| Piece | What it is | Script |
|---|---|---|
| Identity | Cognito user pool, invite-only, email sign-in, optional TOTP; public SPA client, PKCE, no secret | `infra/aws/create-identity.sh` |
| Registry | DynamoDB `coding-cube-workspaces`: `user_id` (HASH) + `workspace_id` (RANGE) -> runtime, access point, role, session | `infra/aws/create-workspace-table.sh` |
| Mint endpoint | HTTP API with a Cognito JWT authorizer -> Lambda that verifies, looks up, and presigns | `infra/aws/create-mint-api.sh` |
| Per-user workspace | One EFS access point at `/workspaces/<sub>`, one execution role, one agent runtime, one registry row | `spike/aws/create-user-workspace.sh` |
| EFS hardening | File system policy: access-point-scoped mounts only | `infra/aws/harden-efs.sh` |
| Self-check | 29 offline checks over the signer, the token verifier and the boundary | `node infra/verify.mjs` |

Reused unchanged from the single-operator build: the VPC, the private subnets, the NAT
gateway, the security group, the filesystem `fs-01bc1a8b94bd929b7`, and the container image.
Nothing in `infra/` recreates any of them.

Order:

```sh
sh infra/aws/create-identity.sh          # -> CUBE_USER_POOL_ID, CUBE_APP_CLIENT_ID
sh infra/aws/create-workspace-table.sh    # -> CUBE_TABLE
sh infra/aws/create-mint-api.sh           # -> CUBE_MINT_ORIGIN
sh infra/aws/harden-efs.sh                # then run the two-sided experiment it prints
aws cognito-idp admin-create-user ...     # invite
CUBE_USER_EMAIL=... sh spike/aws/create-user-workspace.sh
```

Every one of them takes `--dry-run`.

---

## Where authorization actually happens

`infra/lambda/mint.mjs`, and nowhere else. Four invariants, in order:

1. **`sub` comes from a verified RS256 signature, twice.** Once at the HTTP API's JWT
   authorizer, once in `infra/lambda/jwt.mjs`. The second is not ceremony: the day someone
   adds a Function URL or a route without the authorizer, it is what still refuses. If the
   two ever disagree, the request stops.
2. **That `sub` is the DynamoDB partition key.** The client can influence the sort key — which
   of its own workspaces — and nothing else. `infra/lambda/workspaces.mjs` contains one
   `GetItem` and no query, no scan, no index, so *"somebody else's row"* is not expressible in
   the API surface. The IAM policy grants `table/coding-cube-workspaces` and **not**
   `.../index/*`, so the `by_runtime` index is denied to the function even if code for it
   appeared.
3. **The runtime ARN comes from that row.** Never from a header, a query parameter or a body.
4. **Runtime, session and shell are all inside the SigV4 signature.** Editing any of them in
   the returned URL invalidates it, so the decision survives the URL leaving the process.

`shellId` is an allowlist of the six faces, not a pattern — an arbitrary shell is a degree of
freedom the product does not need, and each one counts against the 10-per-session cap.

The session id is the one thing the client still chooses, and that is deliberate. A session
id selects a microVM *within a runtime that is already the caller's*, so it grants nothing on
its own — `infra/verify.mjs` tests exactly this by minting with another user's session id and
asserting the signed URL still names the caller's runtime. Set
`CUBE_SESSION_POLICY=pinned` to take the choice away; see "What changes client-side" for what
that costs.

`node infra/verify.mjs` runs the whole boundary offline: `alg: none`, alg substitution to
HS256, tampered payloads, foreign issuers, foreign app clients, expired tokens, injected
`user_id` parameters, traversal in `shellId`, and the cross-user mint. It also proves the
zero-dependency signer in `infra/lambda/sigv4.mjs` is **byte-identical** to
`spike/harness/shell-client.mjs`, which is the implementation already verified against the
live service — rewriting a signer is only safe against an oracle.

The Lambda has **no dependencies**. Four `.mjs` files, no `package.json`, no bundler,
nothing to install and nothing that can drift from what was reviewed.

---

## Quota ceilings

Read from Service Quotas in `us-east-1`, not from documentation.

| Limit | Value | Adjustable | Why it matters |
|---|---|---|---|
| Total Agents per Account | **100** | yes | **The ceiling on registered users.** Raise this first. |
| `CreateAgentRuntime` rate | 5/s | yes | Provisioning throughput; irrelevant at human speed |
| Access points per file system | **10,000** | **no** | The ceiling on users per filesystem. Reached long after the agent quota, and a hard wall when it is |
| Workload identities | 11,000 | yes | One per agent runtime |
| New sessions/min (container) | 400 | yes | Sign-in stampede after a deploy |
| `InvokeAgentRuntime*` rate | 200/s per agent | yes | Per user, so effectively unbounded |
| Shells per runtime **session** | 10 | no | Six faces; four spare. Measured per session, not per runtime |
| Presigned URL lifetime | 300 s | no | The client re-mints at 270 s |
| `runtimeSessionId` | 33–256 chars | no | `cube-default-<sub>` is 49 |
| `agentRuntimeName` | `[a-zA-Z][a-zA-Z0-9_]{0,47}`, **no hyphens** | no | `cube_u_` + a sub with `-`→`_` is 43 |
| Container image | 2 GB | no | Currently 0.92 GB |
| Cognito MAU | 10,000 free | — | Sign-in is free at any plausible scale here |

At 100 users the account is at its agent-runtime ceiling and at 1% of the access-point
ceiling. There is exactly one number to raise.

---

## Cost, honestly

Measured shape from `spike/RESULTS.md`: **~$0.217/hour** awake at 2 vCPU / 4 GB
(`$0.0895/vCPU-hr × 2 + $0.00945/GB-hr × 4`). Memory is billed for the **whole session
including idle**, and "idle CPU is free" is conditioned on no background process running —
which a cube holding six Herdr panes violates by definition.

**Fixed, shared, already paid for:**

| Item | Monthly |
|---|---|
| NAT gateway | $32.40 + $0.045/GB processed |
| Cognito, DynamoDB, Lambda, HTTP API | ~$0.02 per user; rounds to zero |
| CloudWatch logs (30-day retention) | cents |

The control plane is genuinely free. All the money is in compute and the NAT.

**Per user, at 4 h/day × 22 days, 10 GB stored, `idleRuntimeSessionTimeout=900`:**

| Item | Monthly |
|---|---|
| Compute while working (88 h) | $19.08 |
| Idle tail (88 sleeps × 900 s) | $4.77 |
| EFS storage (10 GB standard) | $3.00 |
| Control plane | $0.02 |
| **Subtotal** | **$26.87** |

The idle tail is 18% of that bill and is the one number under your control. It is a direct
trade against how often a user loses live PIDs — files, git history and Herdr layout survive
eviction regardless:

| `idleRuntimeSessionTimeout` | Idle tail / user / month |
|---|---|
| 300 s | $1.59 |
| 900 s (default here) | $4.77 |
| 1800 s | $9.54 |

**Total, with the NAT amortised:**

| Users | Per user | Account total |
|---|---|---|
| 1 | $59.27 | $59 |
| 10 | $30.11 | $301 |
| 50 | $27.52 | $1,376 |
| 100 | $27.19 | $2,719 |

Which restates the finding from the EFS migration: **at one user this architecture does not
save money** — the NAT costs about what an always-on `t4g.medium` does. The economics invert
at two users and are essentially flat from ten onwards.

Two levers not pulled: a `t4g.nano` NAT instance is ~$3/month (stubbed, not implemented, in
`spike/aws/create-egress.sh`), and EFS Infrequent Access lifecycle policies would cut storage
by roughly 90% for workspaces nobody has touched in 30 days.

`maxLifetime` is what bounds a stuck session. At the default 28,800 s that is ~$1.76 of worst
case per user per incident.

---

## What changes client-side

**The minter's origin, and an `Authorization` header on the three calls it reaches.**

`http://127.0.0.1:8787` becomes `https://<api-id>.execute-api.us-east-1.amazonaws.com`, and
requests carry `Authorization: Bearer <Cognito access token>`. Acquiring and refreshing that
token is the only genuinely new client work — access tokens last 60 minutes while faces
re-mint every 270 seconds, so outliving one is guaranteed rather than hypothetical.

One thing to know before swapping the constant: `main.js` does not read it first. Because the
single-operator minter *serves the Cube*, the page prefers its own origin whenever a
same-origin `GET /session` answers with a `runtimeArn`, and only falls back to the configured
origin otherwise. A multi-user deployment serves the page from somewhere that is not the API,
so the fallback is the path that runs and the swap behaves as described — but a deployment
that ever put the page behind the same host as the API would silently take the same-origin
branch instead.

Unchanged, and unchanged on purpose:

- `public/app/transport.js` — `createShellTransport` is the seam and it does not move.
  `ensureWorkspace` stays a **required** constructor argument, because `/mnt/workspace`
  materialises only on the first `/invocations` call.
- The six shellIds, `face-1` … `face-6`, and the `+1` offset from the Cube's 0-based faces.
- The session model: one session id per browser in `localStorage` under
  `coding-cube.agentcore.session`, chosen by the client.
- `/session`, `/prepare`, `/mint` — same paths, same query parameters (`shellId` or `face`,
  `sessionId`), same response bodies including `expiresIn`, `expiresAt` and
  `refreshAfterSeconds`. `create-mint-api.sh` deploys those three routes and no others.
- The local and Tailscale transports, entirely.

There is **no loopback anywhere** in this path, which matters: Chrome 151 blocks https →
loopback outright ("Permission was denied for this request to access the `loopback` address
space") and `Access-Control-Allow-Private-Network` no longer helps. That is why the
single-operator minter has to serve the Cube itself. Here the app and the API are both
ordinary https origins, so the problem does not arise — but do not "simplify" the
single-operator path by reintroducing it.

**The one thing that would cost a client change** is `CUBE_SESSION_POLICY=pinned`. The server
then owns the session id, and a browser that names a different one gets `409` with the right
id in the body, which the client would have to adopt. It is off by default so that the claim
above stays literally true, but it is the safer setting and worth taking: without it, a user
who clears `localStorage` boots a **second microVM onto the same EFS workspace**. That is a
second $0.217/hour and, more seriously, two herdr instances sharing one socket directory
under `$HOME` — which is on EFS. Enable it before real traffic.

---

## Operations

```sh
# who has a workspace
aws dynamodb scan --table-name coding-cube-workspaces --projection-expression 'user_id,#s' \
  --expression-attribute-names '{"#s":"status"}'

# who owns a runtime (the by_runtime index; the mint Lambda cannot read this)
aws dynamodb query --table-name coding-cube-workspaces --index-name by_runtime \
  --key-condition-expression 'runtime_arn = :r' \
  --expression-attribute-values '{":r":{"S":"arn:aws:bedrock-agentcore:..."}}'

# suspend someone without destroying anything: the Lambda 409s on any status but "ready"
aws dynamodb update-item --table-name coding-cube-workspaces \
  --key '{"user_id":{"S":"<sub>"},"workspace_id":{"S":"default"}}' \
  --update-expression 'SET #s = :s' --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":s":{"S":"suspended"}}'

# revoke tokens already issued (they live up to 60 minutes)
aws cognito-idp admin-user-global-sign-out --user-pool-id <pool> --username <email>

# force a cold microVM without touching files
aws bedrock-agentcore-control ... StopRuntimeSession
```

Suspension takes effect on the next mint, so within 300 seconds — no open shell outlives its
current presigned URL by more than that. Deleting the Cognito user alone does **not** stop an
already-issued token; do the global sign-out, or flip `status`, which is instant and
reversible.

Audit trail: the HTTP API access log records one line per request with the caller's `sub`;
the Lambda log records route, sub, workspace, session and shell. Neither logs the bearer
token or the presigned URL — both are credentials.

---

## What is not built

- **No sign-in UI.** The pool has a hosted domain if `CUBE_COGNITO_DOMAIN` is set; wiring the
  PKCE code flow into the Cube is client work and belongs with the client.
- **No token refresh in the browser.** Access tokens last 60 minutes and a face re-mints every
  270 seconds, so a session outliving its token is guaranteed, not hypothetical.
- **No automatic deprovisioning.** Nothing reclaims a runtime from a dormant user, and the
  quota is 100.
- **The EFS file system policy is unverified.** See above. It is the single largest open
  question in this design.
- **Per-user network isolation.** Every runtime shares one security group. If the file system
  policy turns out not to close the raw-mount path, a security group per runtime plus
  restricted mount targets is the fallback, and it is considerably more machinery.
- **No `--rollback` on anything but `harden-efs.sh`.** The other scripts print teardown and
  expect a human to read it.
