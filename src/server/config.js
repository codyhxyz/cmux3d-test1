import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WORKSPACE } from './herdr-state.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDir, '..', '..');
const DEFAULT_WEB_ORIGIN = 'https://cmux3d-web-test.pages.dev';

export const paths = Object.freeze({
  root: projectRoot,
  public: path.join(projectRoot, 'public'),
});

export function readServerOptions(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8064),
    cwd: env.CMUX3D_WORKDIR || process.cwd(),
    shell: env.CMUX3D_SHELL || env.SHELL,
    herdr: env.CMUX3D_HERDR === '0' ? null : env.CMUX3D_HERDR || 'herdr',
    workspace: env.CMUX3D_WORKSPACE || DEFAULT_WORKSPACE,
    webOrigin: env.CMUX3D_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
    token: env.CMUX3D_TOKEN || randomBytes(24).toString('base64url'),
  };
}
