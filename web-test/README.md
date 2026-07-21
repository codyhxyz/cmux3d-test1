# CMUX3D hosted UI

Cloudflare Pages hosts only the browser UI. HerdR, Pi, PTYs, files, and shell processes remain in the loopback companion.

## Build

```bash
npm install
npm --prefix web-test run build
```

Cloudflare Pages settings:

- Root directory: `web-test`
- Build command: `npm run build`
- Output directory: `dist`

## Use

Run `npm start` from CMUX3D. The companion generates a short-lived pairing token and opens <https://codingcube.codyh.xyz>. The deployed page must receive browser permission to access the local network. If that permission is unavailable, use <http://127.0.0.1:8064/> instead.

The companion:

- binds only to `127.0.0.1`;
- accepts the configured hosted origin and loopback origins only;
- requires the generated pairing token from the hosted origin;
- keeps terminal and HerdR traffic local unless a relay is deliberately added later.

Cloudflare Pages project `cmux3d-web-test` serves the custom domain. Override the hosted origin with `CMUX3D_WEB_ORIGIN`; set `CMUX3D_OPEN=0` to disable auto-opening.
