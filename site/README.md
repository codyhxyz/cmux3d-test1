# Coding Cube hosted UI

Cloudflare Pages serves the browser UI **and** the minting API. `functions/` holds the three
endpoints a browser needs to reach an AgentCore runtime — the same `/session`, `/prepare` and
`/mint` the loopback minter serves, same response shapes.

Terminals, PTYs, files and Herdr still live in the runtime. Nothing here holds state; the
Functions sign URLs and forward one `/invocations` call.

## Build

```bash
npm install            # from the repo root — the build reads root node_modules
npm --prefix site run build
```

Cloudflare Pages settings:

- Root directory: `site`
- Build command: `npm run build`
- Output directory: `dist`

Functions are picked up from `site/functions/` automatically. To check they still compile
without deploying:

```bash
npx wrangler pages functions build --outdir=/tmp/fnbuild
```

## Configure

### The pairing code

The page is public. The three API paths are not: they require `X-Cube-Token` to match the
`CUBE_PAIRING_TOKEN` secret. This is the same mechanism the loopback gateway has always used
— one secret, held by the operator's browser in `localStorage`, paired once and kept.

Pair a browser by opening the site once with the code in the fragment:

```
https://codingcube.codyh.xyz/#token=<CUBE_PAIRING_TOKEN>
```

`connection.js` adopts it onto the active host and strips it from the URL. There is no login
page, nothing expires, and Cloudflare Zero Trust is not involved.

It is a bearer token and nothing more: whoever holds it gets shells. That is the accepted
blast radius for one operator, and it is the reason the page can stay public while this does
not. **Multi-user replaces this with a verified identity keyed to a per-user runtime** — see
[`../MULTI_USER.md`](../MULTI_USER.md). It does not layer on top of it.

A header, not a query parameter: all three routes are `fetch()` calls, and a token in a query
string lands in Cloudflare's request logs, browser history, and any `Referer` that escapes.

### Three secrets

```bash
npx wrangler pages secret put CUBE_AWS_ACCESS_KEY_ID     --project-name coding-cube
npx wrangler pages secret put CUBE_AWS_SECRET_ACCESS_KEY --project-name coding-cube
npx wrangler pages secret put CUBE_PAIRING_TOKEN         --project-name coding-cube
```

The AWS key is the one from `spike/aws/create-minter-user.sh` — a user that can invoke one
runtime and open shells on it, and can create and delete nothing. That matters, because it
now sits in Cloudflare's secret store rather than your `~/.aws/credentials`.

### Plain variables go in `wrangler.toml`, not the dashboard

`CUBE_RUNTIME_ARN` lives in `[vars]`. On a direct upload wrangler treats `wrangler.toml` as
authoritative for vars, so anything set only in the dashboard is silently dropped from the
deployment — measured, after the ARN sat on the project and stayed invisible to the Function.
Secrets are managed separately and do persist.

Optional: `CUBE_REGION` (defaults to the region in the ARN), `CUBE_QUALIFIER`,
`CUBE_MINT_EXPIRES`.

`CUBE_SESSION_POLICY=pinned` is **not** safe to turn on yet. It would stop a browser with
cleared storage booting a second microVM onto the same EFS workspace, but the server then
409s any client-named session and `main.js` does not adopt the id from the response body.
Teach the client to adopt it first.

## Why there is no signer in this directory

`lib/cloud.js` imports `presignShellUrl` and `signRequest` from
`../../spike/harness/shell-client.mjs` with `signer: 'raw'`. That file is kept free of
top-level `node:` imports precisely so a browser or a Worker can use it, and its `raw` path
is already pure `crypto.subtle`. It is also the implementation verified byte-correct against
the live service, and `node infra/verify.mjs` diffs the `raw` branch against the `@smithy`
one on every run.

Writing a Workers-flavoured SigV4 here would have been a fourth copy of an algorithm that
already had three, and the only one with no oracle behind it.
