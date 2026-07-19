export function browserOriginAllowed(origin, webOrigin) {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || origin === webOrigin;
  } catch {
    return false;
  }
}

export function hostedRequestAuthorized(req, requestUrl, webOrigin, token) {
  return !webOrigin || req.headers.origin !== webOrigin || requestUrl.searchParams.get('token') === token;
}

export function allowCors(req, res, webOrigin) {
  const origin = req.headers.origin;
  if (!origin || !browserOriginAllowed(origin, webOrigin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-private-network', 'true');
  res.setHeader('vary', 'Origin');
  return true;
}
