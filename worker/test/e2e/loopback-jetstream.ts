import WebSocket, { type ClientOptions } from 'ws';
import { createJetstreamWsConnector, type WsClientCtor } from '../../src/node/jetstream-ws';

const SAFE_ERROR = 'test Jetstream target was refused';

/** Redirects only the test Jetstream hostname to one explicit local ws listener. */
export function createLoopbackJetstreamConnector(localOrigin: string, jetstreamUrls: readonly string[]) {
  let local: URL;
  try {
    local = new URL(localOrigin);
  } catch {
    throw new Error(SAFE_ERROR);
  }
  if (
    local.protocol !== 'ws:' ||
    local.hostname !== '127.0.0.1' ||
    !local.port ||
    local.username ||
    local.password ||
    local.pathname !== '/' ||
    local.search ||
    local.hash
  ) {
    throw new Error(SAFE_ERROR);
  }

  class LoopbackWebSocket extends WebSocket {
    constructor(address: string, options: ClientOptions) {
      let requested: URL;
      try {
        requested = new URL(address);
      } catch {
        throw new Error(SAFE_ERROR);
      }
      if (
        requested.protocol !== 'wss:' ||
        requested.hostname !== 'jetstream.test' ||
        (requested.port !== '' && requested.port !== '443') ||
        requested.username ||
        requested.password ||
        requested.hash
      ) {
        throw new Error(SAFE_ERROR);
      }
      const target = new URL(local.origin);
      target.pathname = requested.pathname;
      target.search = requested.search;
      super(target.toString(), options);
    }
  }

  return createJetstreamWsConnector({
    jetstreamUrls,
    WebSocket: LoopbackWebSocket as WsClientCtor,
  });
}
