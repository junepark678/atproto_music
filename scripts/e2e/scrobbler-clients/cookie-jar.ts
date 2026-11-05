import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

const SAFE_ERROR = 'scrobbler e2e app request failed';

interface Cookie {
  name: string;
  value: string;
  path: string;
}

export interface LocalCookieJarOptions {
  /** Public HTTPS origin sent as Host and used to scope cookies. */
  publicOrigin: string;
  /** Explicit local HTTP listener, normally http://127.2.0.1:<ephemeral-port>. */
  transportOrigin: string;
}

/** A cookie jar whose only destination is the supplied local e2e bundle. */
export class LocalCookieJar {
  readonly #publicOrigin: URL;
  readonly #transportOrigin: URL;
  readonly #cookies = new Map<string, Cookie>();

  constructor(options: LocalCookieJarOptions) {
    try {
      this.#publicOrigin = new URL(options.publicOrigin);
      this.#transportOrigin = new URL(options.transportOrigin);
    } catch {
      throw new Error(SAFE_ERROR);
    }
    if (
      this.#publicOrigin.protocol !== 'https:' ||
      this.#publicOrigin.username ||
      this.#publicOrigin.password ||
      this.#publicOrigin.pathname !== '/' ||
      this.#publicOrigin.search ||
      this.#publicOrigin.hash ||
      (this.#publicOrigin.port !== '' && this.#publicOrigin.port !== '443')
    ) {
      throw new Error(SAFE_ERROR);
    }
    const loopback =
      this.#transportOrigin.hostname === 'localhost' ||
      /^127(?:\.\d{1,3}){3}$/.test(this.#transportOrigin.hostname) ||
      this.#transportOrigin.hostname === '[::1]';
    if (
      this.#transportOrigin.protocol !== 'http:' ||
      !loopback ||
      !this.#transportOrigin.port ||
      this.#transportOrigin.username ||
      this.#transportOrigin.password ||
      this.#transportOrigin.pathname !== '/' ||
      this.#transportOrigin.search ||
      this.#transportOrigin.hash
    ) {
      throw new Error(SAFE_ERROR);
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    let target: URL;
    let headers: Record<string, string>;
    let body: string | Buffer | undefined;
    try {
      const publicUrl = new URL(path, this.#publicOrigin);
      if (publicUrl.origin !== this.#publicOrigin.origin) throw new Error();
      // Assign URL components instead of resolving a `//...` pathname, which
      // URL() would interpret as an authority and could send the cookie to a
      // different host.
      target = new URL(this.#transportOrigin.origin);
      target.pathname = publicUrl.pathname;
      target.search = publicUrl.search;
      if (target.origin !== this.#transportOrigin.origin) throw new Error();
      headers = Object.fromEntries(new Headers(init.headers).entries());
      headers.host = this.#publicOrigin.host;
      const cookie = this.#cookieHeader(publicUrl.pathname);
      if (cookie === '') delete headers.cookie;
      else headers.cookie = cookie;
      if (typeof init.body === 'string') body = init.body;
      else if (init.body instanceof URLSearchParams) body = init.body.toString();
      else if (init.body instanceof Uint8Array) body = Buffer.from(init.body);
      else if (init.body !== undefined && init.body !== null) throw new Error();
    } catch {
      throw new Error(SAFE_ERROR);
    }

    return new Promise((resolve, reject) => {
      try {
        const req = httpRequest(target, { method: init.method ?? 'GET', headers }, (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          incoming.once('aborted', () => reject(new Error(SAFE_ERROR)));
          incoming.once('error', () => reject(new Error(SAFE_ERROR)));
          incoming.once('end', () => {
            try {
              this.#storeCookies(incoming.headers['set-cookie'] ?? []);
              const status = incoming.statusCode ?? 502;
              const noBody = status === 204 || status === 205 || status === 304;
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(incoming.headers as IncomingHttpHeaders)) {
                if (value === undefined || name === 'set-cookie') continue;
                for (const item of Array.isArray(value) ? value : [value]) {
                  if (typeof item === 'string') responseHeaders.append(name, item);
                }
              }
              resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
            } catch {
              reject(new Error(SAFE_ERROR));
            }
          });
        });
        req.once('error', () => reject(new Error(SAFE_ERROR)));
        req.end(body);
      } catch {
        reject(new Error(SAFE_ERROR));
      }
    });
  }

  /** Cookie header for an explicitly same-origin browser-style replay request. */
  cookieHeader(path = '/'): string {
    return this.#cookieHeader(path);
  }

  #cookieHeader(pathname: string): string {
    return [...this.#cookies.values()]
      .filter(
        (cookie) =>
          pathname === cookie.path ||
          (pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || pathname[cookie.path.length] === '/')),
      )
      .sort((left, right) => right.path.length - left.path.length)
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
  }

  #storeCookies(values: readonly string[]): void {
    for (const raw of values) {
      const segments = raw.split(';').map((segment) => segment.trim());
      const first = segments.shift() ?? '';
      const equals = first.indexOf('=');
      if (equals < 1) continue;
      const name = first.slice(0, equals);
      const value = first.slice(equals + 1);
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) {
        throw new Error(SAFE_ERROR);
      }
      const attributes = new Map<string, string | true>();
      for (const segment of segments) {
        const separator = segment.indexOf('=');
        const key = (separator < 0 ? segment : segment.slice(0, separator)).toLowerCase();
        const attributeValue = separator < 0 ? true : segment.slice(separator + 1);
        attributes.set(key, attributeValue);
      }
      const pathAttribute = attributes.get('path');
      const path = typeof pathAttribute === 'string' && pathAttribute.startsWith('/') ? pathAttribute : '/';
      if (name.startsWith('__Host-') && (attributes.has('domain') || !attributes.has('secure') || path !== '/')) {
        throw new Error(SAFE_ERROR);
      }
      const key = `${name}\u0000${path}`;
      const maxAge = attributes.get('max-age');
      if (typeof maxAge === 'string' && Number(maxAge) <= 0) this.#cookies.delete(key);
      else this.#cookies.set(key, { name, value, path });
    }
  }
}
