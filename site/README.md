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

### One Access application

Cloudflare Access covers **the whole hostname**, not just the API paths. That is deliberate:
an Access app in front of `/mint` answers an unauthenticated `fetch()` with a 302 to the
identity provider, which arrives at the page as an HTML body where JSON was expected —
indistinguishable from a broken minter. Covering the site means the browser is already
authenticated before any script runs.

The cost is that the cube is no longer a public page. It is a terminal on a machine you own,
so that is the right trade, but it is a trade.

- Application type: Self-hosted
- Domain: `codingcube.codyh.xyz`, path empty (the whole host)
- Policy: Allow → Emails → your address

Access then injects `Cf-Access-Authenticated-User-Email` on every request that reaches a
Function. `lib/cloud.js` reads it and **refuses to sign anything if it is absent**, so a
deployment whose Access application was deleted or misconfigured fails closed rather than
handing root shells to the internet.

### Three secrets and one variable

```bash
npx wrangler pages secret put CUBE_AWS_ACCESS_KEY_ID     --project-name coding-cube
npx wrangler pages secret put CUBE_AWS_SECRET_ACCESS_KEY --project-name coding-cube
```

`CUBE_RUNTIME_ARN` is not a secret; set it as a plain environment variable on the Pages
project. Optional: `CUBE_REGION` (defaults to the region in the ARN), `CUBE_QUALIFIER`,
`CUBE_MINT_EXPIRES`, and `CUBE_SESSION_POLICY=pinned` to stop a browser with cleared storage
booting a second microVM onto the same EFS workspace.

The key is the one from `spike/aws/create-minter-user.sh` — a user that can invoke one
runtime and open shells on it, and can create and delete nothing. That matters, because it
now sits in Cloudflare's secret store rather than your `~/.aws/credentials`.

## Why there is no signer in this directory

`lib/cloud.js` imports `presignShellUrl` and `signRequest` from
`../../spike/harness/shell-client.mjs` with `signer: 'raw'`. That file is kept free of
top-level `node:` imports precisely so a browser or a Worker can use it, and its `raw` path
is already pure `crypto.subtle`. It is also the implementation verified byte-correct against
the live service, and `node infra/verify.mjs` diffs the `raw` branch against the `@smithy`
one on every run.

Writing a Workers-flavoured SigV4 here would have been a fourth copy of an algorithm that
already had three, and the only one with no oracle behind it.
