# CMUX3D

A rotatable coding cube with six persistent Herdr sessions. Each face attaches to its matching `cmux3d-*` session through `node-pty` and xterm.js; the workspace behind it is a dependency-free custom WebGL fragment shader that responds to orbit, focus, and pointer movement.

## Run

```bash
npm install
npm start
```

Open <http://127.0.0.1:8064/>. To use another port or working directory:

```bash
PORT=8070 CMUX3D_WORKDIR="$PWD" npm start

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
- Press `Esc` to release focus

## Verify

```bash
npm run smoke
```

Raw Herdr snapshots for all six face sessions are available at `GET /api/herdr/state`.

The server binds to loopback by default because every terminal is a real shell with access to the configured working directory.
