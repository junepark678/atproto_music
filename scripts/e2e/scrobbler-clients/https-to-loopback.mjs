// E2E-only preload for the real lastfm-ts-api client. Its HTTPS request is
// redirected to the local e2e worker while retaining the public authority.
// This module intentionally has no general-purpose proxy behavior.
import https from 'node:https';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

const PUBLIC_HOST = 'music.214510.xyz';
const LOOPBACK_HOST = '127.2.0.1';
const portText = process.env.ATMUSIC_E2E_SCROBBLER_PORT;
if (!/^\d+$/.test(portText ?? '')) {
  throw new Error('ATMUSIC_E2E_SCROBBLER_PORT must be a local TCP port');
}
const port = Number(portText);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('ATMUSIC_E2E_SCROBBLER_PORT must be a local TCP port');
}

function hostnameOf(input, options) {
  const override = options?.hostname ?? options?.host;
  if (override !== undefined) return String(override).toLowerCase();
  if (typeof input === 'string' || input instanceof URL) return new URL(input).hostname.toLowerCase();
  return String(input?.hostname ?? input?.host ?? '').toLowerCase();
}

function authorityHost(host) {
  // Node's options.hostname is host-only; reject ports and userinfo instead of
  // accidentally treating a non-public authority as an allowed hostname.
  return host === PUBLIC_HOST;
}

function request(input, options, callback) {
  let opts = options;
  let cb = callback;
  if (typeof opts === 'function') {
    cb = opts;
    opts = undefined;
  }
  const host = hostnameOf(input, opts);
  if (!authorityHost(host)) {
    throw new Error(`HTTPS e2e preload refused hostname ${host || '(missing)'}`);
  }

  const source = typeof input === 'string' || input instanceof URL
    ? new URL(input)
    : null;
  const supplied = typeof input === 'object' && !(input instanceof URL) ? input : {};
  const config = typeof opts === 'string' ? { ...new URL(opts) } : (opts ?? {});
  const protocol = config.protocol ?? supplied.protocol ?? source?.protocol ?? 'https:';
  const requestPort = config.port ?? supplied.port ?? source?.port ?? '';
  if (protocol !== 'https:' || (requestPort !== '' && requestPort !== 443 && requestPort !== '443')) {
    throw new Error('HTTPS e2e preload refused a non-HTTPS or non-default-port request');
  }
  const path = config.path ?? supplied.path ?? (source ? `${source.pathname}${source.search}` : '/');
  const headers = { ...(supplied.headers ?? {}), ...(config.headers ?? {}) };
  for (const sourceOptions of [supplied, config]) {
    for (const key of ['socketPath', 'createConnection', 'lookup', 'agent', '_defaultAgent', 'localAddress', 'family', 'autoSelectFamily']) {
      if (sourceOptions[key] !== undefined) {
        throw new Error(`HTTPS e2e preload refused transport override ${key}`);
      }
    }
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'host')) {
    headers.Host = PUBLIC_HOST;
  }
  const method = config.method ?? supplied.method ?? 'GET';
  const timeout = config.timeout ?? supplied.timeout;
  const signal = config.signal ?? supplied.signal;
  const target = http.request(
    {
      protocol: 'http:',
      hostname: LOOPBACK_HOST,
      host: LOOPBACK_HOST,
      port,
      agent: false,
      path,
      method,
      headers,
      ...(timeout === undefined ? {} : { timeout }),
      ...(signal === undefined ? {} : { signal }),
    },
    (response) => {
      try {
        process.send?.({
          type: 'request-observed',
          host: PUBLIC_HOST,
          method,
          path: typeof path === 'string' ? path.split('?')[0] : '/',
          status: response.statusCode ?? 0,
        });
      } catch {}
      cb?.(response);
    },
  );
  target.on('socket', (socket) => {
    socket.once('connect', () => {
      try {
        process.send?.({ type: 'connection-observed', remoteAddress: socket.remoteAddress, remotePort: socket.remotePort });
      } catch {}
    });
  });
  return target;
}

https.request = request;
syncBuiltinESMExports();
