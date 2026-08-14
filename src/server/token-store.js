import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

export function stateDir(env = process.env) {
  return env.CODING_CUBE_STATE_DIR || path.join(env.HOME || os.homedir(), '.coding-cube');
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

  return write(file, newToken());
}

export function newToken() {
  return randomBytes(24).toString('base64url');
}

export function rotateToken(env = process.env) {
  try {
    fs.unlinkSync(path.join(stateDir(env), 'token'));
  } catch {
    // Nothing to rotate.
  }
  return loadOrCreateToken(env);
}

// The hosted cloud's pairing code (site/README.md) is a Cloudflare secret, and Cloudflare
// will not read a secret back. So this copy is the only one a Mac can put in a QR, and a
// machine that never had it can only mint a new one — `coding-cube pair --new-code`.
//
// Deliberately never created on demand, unlike the local token: inventing a code here would
// produce a QR that pairs a phone to nothing.
export function loadCloudToken(env = process.env) {
  const supplied = String(env.CUBE_PAIRING_TOKEN || '').trim();
  if (supplied) return supplied;
  try {
    const stored = fs.readFileSync(cloudTokenFile(env), 'utf8').trim();
    return TOKEN_PATTERN.test(stored) ? stored : '';
  } catch {
    return '';
  }
}

export function saveCloudToken(token, env = process.env) {
  if (!TOKEN_PATTERN.test(token)) throw new Error('a pairing code is 16 or more letters, digits, - or _');
  fs.mkdirSync(stateDir(env), { recursive: true, mode: 0o700 });
  return write(cloudTokenFile(env), token);
}

function cloudTokenFile(env) {
  return path.join(stateDir(env), 'cloud-token');
}

function write(file, token) {
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file; an existing one keeps
  // whatever permissions it had.
  fs.chmodSync(file, 0o600);
  return token;
}
