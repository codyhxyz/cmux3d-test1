# CMUX3D

A rotatable coding cube for the six tabs in your persistent Herdr `Coding Cube` workspace. Each face discovers its existing tab and attaches directly to that tab's terminal through `node-pty` and xterm.js; the workspace behind it is a dependency-free custom WebGL fragment shader that responds to orbit, focus, and pointer movement.

## Run

```bash
npm install
npm start
```

`npm start` opens <https://codingcube.codyh.xyz> with a one-time pairing token; HerdR, Pi, terminals, and files remain on the local machine. The local-only fallback is <http://127.0.0.1:8064/>. Set `CMUX3D_OPEN=0` to prevent auto-opening.

To use another working directory or a local-only custom port:

```bash
CMUX3D_WORKDIR="$PWD" npm start
PORT=8070 CMUX3D_OPEN=0 npm start

# Adopt a differently named six-tab Herdr workspace
CMUX3D_WORKSPACE="My Cube" npm start

# Use ordinary local shells instead of Herdr
CMUX3D_HERDR=0 npm start
```

## Controls

- Drag to orbit the cube
- Click a face or use the face rail to focus its shell
- Type directly into the focused terminal
- Scroll to zoom
- Move the pointer to nudge the default zero-gravity drift
- Adjust face opacity, momentum duration, or zero gravity in Settings
- Choose a webcam and enable Hand control in Settings, then pinch either hand to orbit or pinch both to orbit and zoom
- Press `Esc` to release focus

## Verify

```bash
npm run smoke
```

Per-face views of the canonical Herdr snapshot are available at `GET /api/herdr/state`. Startup fails rather than creating replacement sessions unless exactly one configured workspace contains one terminal tab named `Face 1` through `Face 6`; unrelated tabs are ignored.

Hand control is off by default. MediaPipe runs in a browser worker; camera frames are processed locally and are not uploaded.

The server binds to loopback by default because every terminal is a real shell with access to the configured working directory.
