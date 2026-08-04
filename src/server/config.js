import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST_ADDRESS, DEFAULT_HOST_PORT, DEFAULT_WEB_ORIGIN } from '../../public/app/connection-config.js';
import { DEFAULT_WORKSPACE } from './herdr-state.js';
import { loadOrCreateToken, rotateToken } from './token-store.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDir, '..', '..');

export const paths = Object.freeze({
  root: projectRoot,
  public: path.join(projectRoot, 'public'),
});

export function readServerOptions(env = process.env, argv = process.argv) {
  const rotate = env.CMUX3D_ROTATE_TOKEN === '1' || argv.includes('--rotate-token');
  return {
    host: env.HOST || DEFAULT_HOST_ADDRESS,
    port: Number(env.PORT || DEFAULT_HOST_PORT),
    cwd: env.CMUX3D_WORKDIR || process.cwd(),
    shell: env.CMUX3D_SHELL || env.SHELL,
    herdr: !env.CMUX3D_HERDR || env.CMUX3D_HERDR === '0' ? null : env.CMUX3D_HERDR,
    workspace: env.CMUX3D_WORKSPACE || DEFAULT_WORKSPACE,
    webOrigin: env.CMUX3D_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
    gatewayOnly: env.CMUX3D_GATEWAY_ONLY === '1',
    // The env override is honoured but never written to disk.
    token: env.CMUX3D_TOKEN || (rotate ? rotateToken(env) : loadOrCreateToken(env)),
    rotated: rotate && !env.CMUX3D_TOKEN,
    expose: env.CMUX3D_TAILSCALE === '1' || argv.includes('--expose'),
    serveOnly: env.CMUX3D_TAILSCALE === 'serve',
    tailscaleUsers: String(env.CMUX3D_TAILSCALE_USERS || '').split(',').map((login) => login.trim()).filter(Boolean),
    // Tailscale authenticates your devices already; asking them for a code too
    // buys nothing. CMUX3D_REQUIRE_CODE=1 demands one anyway.
    trustTailnet: env.CMUX3D_REQUIRE_CODE !== '1',
  };
}
