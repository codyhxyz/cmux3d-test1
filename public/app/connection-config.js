export const DEFAULT_COMPANION_HOST = '127.0.0.1';
export const DEFAULT_COMPANION_PORT = 8064;
export const DEFAULT_WEB_ORIGIN = 'https://cmux3d-web-test.pages.dev';

export function isLoopbackHostname(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}
