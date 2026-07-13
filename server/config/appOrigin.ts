export function resolveAppOrigin(env: Record<string, string | undefined>): string {
  const isProduction = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const configured = String(env.APP_ORIGIN || (!isProduction ? env.CLIENT_ORIGIN : '') || '').trim();
  if (!configured) {
    if (isProduction) throw new Error('[env] APP_ORIGIN is required in production.');
    return 'http://localhost:5173';
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('[env] APP_ORIGIN must be an absolute HTTP(S) origin.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('[env] APP_ORIGIN must be an absolute HTTP(S) origin.');
  }

  const hostname = url.hostname.toLowerCase();
  const isLocal = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' ||
    hostname === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (isProduction && isLocal) {
    throw new Error('[env] APP_ORIGIN must use a public hostname in production.');
  }
  return url.origin;
}

const APP_ORIGIN = (() => {
  try {
    return resolveAppOrigin(process.env);
  } catch {
    return 'http://localhost:5173';
  }
})();

export { APP_ORIGIN };
