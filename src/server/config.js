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
  const rotate = env.CODING_CUBE_ROTATE_TOKEN === '1' || argv.includes('--rotate-token');
  return {
    cloud: readCloudOptions(env, argv),
    // Kept separate so `--cloud` with no runtime ARN is a loud error rather than a
    // local-only cube that quietly ignored the flag.
    cloudRequested: env.CODING_CUBE_CLOUD === '1' || argv.includes('--cloud'),
    host: env.HOST || DEFAULT_HOST_ADDRESS,
    port: Number(env.PORT || DEFAULT_HOST_PORT),
    cwd: env.CODING_CUBE_WORKDIR || process.cwd(),
    shell: env.CODING_CUBE_SHELL || env.SHELL,
    herdr: !env.CODING_CUBE_HERDR || env.CODING_CUBE_HERDR === '0' ? null : env.CODING_CUBE_HERDR,
    workspace: env.CODING_CUBE_WORKSPACE || DEFAULT_WORKSPACE,
    webOrigin: env.CODING_CUBE_WEB_ORIGIN || DEFAULT_WEB_ORIGIN,
    gatewayOnly: env.CODING_CUBE_GATEWAY_ONLY === '1',
    // The env override is honoured but never written to disk.
    token: env.CODING_CUBE_TOKEN || (rotate ? rotateToken(env) : loadOrCreateToken(env)),
    rotated: rotate && !env.CODING_CUBE_TOKEN,
    expose: env.CODING_CUBE_TAILSCALE === '1' || argv.includes('--expose'),
    serveOnly: env.CODING_CUBE_TAILSCALE === 'serve',
    tailscaleUsers: String(env.CODING_CUBE_TAILSCALE_USERS || '').split(',').map((login) => login.trim()).filter(Boolean),
    // Tailscale authenticates your devices already; asking them for a code too
    // buys nothing. CODING_CUBE_REQUIRE_CODE=1 demands one anyway.
    trustTailnet: env.CODING_CUBE_REQUIRE_CODE !== '1',
  };
}

// The cloud path is off unless a runtime ARN names one, so a plain local user never
// grows a /mint endpoint. `force` is for the standalone minter, which has no reason
// to exist with the cloud switched off.
export function readCloudOptions(env = process.env, argv = process.argv, { force = false } = {}) {
  const runtimeArn = argValue(argv, 'runtime-arn') || env.CUBE_RUNTIME_ARN || '';
  const disabled = env.CODING_CUBE_CLOUD === '0' || argv.includes('--no-cloud');
  if (!runtimeArn || (disabled && !force)) return null;
  const session = argValue(argv, 'session') || env.CUBE_SESSION_ID || '';
  const profile = env.CUBE_AWS_PROFILE || env.AWS_PROFILE || null;
  return {
    runtimeArn,
    // The ARN already carries the region; CUBE_REGION is only for someone pointing an
    // ARN-shaped override somewhere else.
    region: argValue(argv, 'region') || env.CUBE_REGION || runtimeArn.split(':')[3] || env.AWS_REGION || 'us-east-1',
    qualifier: argValue(argv, 'qualifier') || env.CUBE_QUALIFIER || 'DEFAULT',
    sessionId: session || null,
    pinSession: argv.includes('--pin-session') || env.CUBE_PIN_SESSION === '1',
    expiresIn: Number(argValue(argv, 'expires') || env.CUBE_MINT_EXPIRES || 300),
    signer: argValue(argv, 'signer') || env.CUBE_SIGNER || 'aws-sdk',
    profile,
    // Only an explicit CUBE_AWS_PROFILE outranks credentials already in the
    // environment; an inherited AWS_PROFILE does not get to override them.
    profilePinned: Boolean(env.CUBE_AWS_PROFILE),
    origins: String(argValue(argv, 'origin') || env.CUBE_MINT_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

// --name value and --name=value, matching the spike minter's flags. Returns '' rather
// than true for a bare flag so a missing value can never become a runtime ARN.
function argValue(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === `--${name}`) {
      const next = argv[index + 1];
      return next && !next.startsWith('--') ? next : '';
    }
    if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
  }
  return '';
}
