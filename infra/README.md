# infra/

The multi-user control plane. Architecture, cost and the isolation argument are in
[`../MULTI_USER.md`](../MULTI_USER.md); this file is just the map.

Nothing here has been run. Every script prints a plan, refuses on the wrong account, demands
a typed confirmation, and prints its own teardown. All of them take `--dry-run`.

```
aws/create-identity.sh         Cognito user pool + app client (invite only, PKCE, no secret)
aws/create-workspace-table.sh  DynamoDB user_id -> workspace_id -> runtime / access point / session
aws/create-mint-api.sh         IAM role, Lambda, HTTP API + Cognito JWT authorizer. Also the redeploy.
aws/harden-efs.sh              EFS file system policy: access-point-scoped mounts only. --rollback
lambda/mint.mjs                The handler. The entire security boundary; read its header first.
lambda/jwt.mjs                 Cognito RS256 verification, JWKS cached, alg pinned
lambda/sigv4.mjs               SigV4 presign + header auth on node:crypto
lambda/workspaces.mjs          GetItem / UpdateItem. One read, keyed on the verified sub
policies/                      Trust and inline policies, static ARNs, checked by the scripts
verify.mjs                     node infra/verify.mjs — 29 offline checks, no AWS
```

Per-user provisioning lives with the other AgentCore scripts it reuses:
`../spike/aws/create-user-workspace.sh`.

The Lambda has no dependencies and no `package.json`: four `.mjs` files zipped flat. If you
add one, you have added a supply chain to the one process that can sign a shell URL.

Run `node infra/verify.mjs` after any change to `lambda/`.
