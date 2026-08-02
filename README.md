# CMUX3D

A rotatable workspace for six shells. It runs with ordinary local shells out of the box and can attach each face to a tab in a persistent Herdr `Coding Cube` workspace.

## Run

```bash
npm install
npm start
```

`npm start` opens <https://codingcube.codyh.xyz> with a pairing code. Click a face and type: each face starts an ordinary shell in the current directory. Terminals and files remain on the computer running `npm start`. If the hosted page cannot connect, open <http://127.0.0.1:8064/>.

The pairing code is stored in `~/.cmux3d/token`, so devices you have paired stay paired across restarts. Rotate it with `npm start -- --rotate-token`.

To use another working directory or a local-only custom port:

```bash
CMUX3D_WORKDIR="$PWD" npm start
PORT=8070 CMUX3D_OPEN=0 npm start
```

To attach an existing six-tab Herdr workspace instead of starting ordinary shells:

```bash
CMUX3D_HERDR=herdr npm start
CMUX3D_HERDR=herdr CMUX3D_WORKSPACE="My Cube" npm start
```

Herdr mode expects exactly one configured workspace containing one terminal tab named `Face 1` through `Face 6`; unrelated tabs are ignored.

## Controls

- Drag to orbit the cube
- Click a face or use the face rail to focus its shell
- Type directly into the focused terminal
- Pinch or scroll to zoom
- Move the pointer to nudge the default zero-gravity drift
- Adjust face opacity, momentum duration, or zero gravity in Settings
- Choose a webcam and enable Hand control in Settings, then pinch either hand to orbit or pinch both to orbit and zoom
- Tap away from the cube, or press `Esc`, to release focus

## On a phone

Phones get the same six shells, not a preview. The cube needs a computer to run them on. With Tailscale installed on both devices under the same account:

```bash
npm start -- --expose
```

That binds to your tailnet address and prints a link like `http://mymac.tail1234.ts.net:8064/#token=…`. Open it on the phone — the link carries both the address and the pairing code — and you are connected. Nothing else to configure: no certificate, no `tailscale serve`, no port forwarding.

Once connected, tap a face to focus it and the keyboard comes up. A key row above the keyboard carries `esc`, `tab`, a sticky `ctrl`, arrows, and paste. Tap away from the cube to release.

To reach the cube through the hosted page at <https://codingcube.codyh.xyz> instead of the tailnet address, that page is https, so it needs a TLS route to your computer: run `tailscale serve --bg 8064`, which requires HTTPS certificates enabled for your tailnet. CMUX3D detects this and prints the pairing link and a scannable QR code when it is available. This is a convenience, not a requirement — the direct address above gives you the same shells.

Exposure is opt-in. Without `--expose` the server stays on loopback, and `--expose` binds only to the tailnet interface, so the local network cannot see it. Anything reaching the server from beyond loopback must present the pairing code, whether or not it sends a browser `Origin` header.

## Verify

```bash
npm run smoke
```

In Herdr mode, per-face views of the canonical snapshot are available at `GET /api/herdr/state`.

Hand control is off by default. MediaPipe runs in a browser worker; camera frames are processed locally and are not uploaded.

The server binds to loopback by default because every terminal is a real shell with access to the configured working directory.
