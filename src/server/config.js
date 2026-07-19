import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COMPANION_HOST, DEFAULT_COMPANION_PORT, DEFAULT_WEB_ORIGIN } from '../../public/app/connection-config.js';
import { DEFAULT_WORKSPACE } from './herdr-state.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDir, '..', '..');

export const paths = Object.freeze({
  root: projectRoot,
  public: path.join(projectRoot, 'public'),
});

export function readServerOptions(env = process.env) {
  return {
    host: env.HOST || DEFAULT_COMPANION_HOST,
    port: Number(env.PORT || DEFAULT_COMPANION_PORT),
    cwd: env.CMUX3D_WORKDIR || process.cwd(),
    shell: env.CMUX3D_SHELL || env.SHELL,
    herdr: env.CMUX3D_HERDR === '0' ? null : env.CMUX3D_HERDR || 'herdr',
    workspace: env.CMUX3D_WORKSPACE || DEFAULT_WORKSPACE,
    webOrigin: env.CMUX3D_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
    token: env.CMUX3D_TOKEN || randomBytes(24).toString('base64url'),
  };
}
