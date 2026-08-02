import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

export function stateDir(env = process.env) {
  return env.CMUX3D_STATE_DIR || path.join(env.HOME || os.homedir(), '.cmux3d');
}

// Pairing survives restarts so a phone stays paired; the file is the only secret on disk.
export function loadOrCreateToken(env = process.env) {
  const dir = stateDir(env);
  const file = path.join(dir, 'token');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (TOKEN_PATTERN.test(existing)) {
      fs.chmodSync(file, 0o600);
      return existing;
    }
  } catch {
    // Missing or unreadable; mint a new one below.
  }

  const token = randomBytes(24).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

export function rotateToken(env = process.env) {
  try {
    fs.unlinkSync(path.join(stateDir(env), 'token'));
  } catch {
    // Nothing to rotate.
  }
  return loadOrCreateToken(env);
}
