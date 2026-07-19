import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export function resolveExecutable(command) {
  if (!command) return null;
  const candidates = command.includes(path.sep)
    ? [command]
    : (process.env.PATH || '').split(path.delimiter).map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function chooseShell(preferred) {
  return [preferred, '/bin/zsh', '/bin/bash', '/bin/sh']
    .map(resolveExecutable)
    .find(Boolean) || '/bin/sh';
}

export function repairDarwinPtyHelper() {
  if (process.platform !== 'darwin') return;
  const helperPath = path.join(
    paths.root,
    'node_modules',
    'node-pty',
    'prebuilds',
    `darwin-${process.arch}`,
    'spawn-helper',
  );
  try {
    if (fs.existsSync(helperPath)) fs.chmodSync(helperPath, 0o755);
  } catch (error) {
    console.warn(`node-pty helper permission check failed: ${error.message}`);
  }
}
