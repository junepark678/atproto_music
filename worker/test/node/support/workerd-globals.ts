// Setup file of the worker-modules project on Node (ADR 0005 §15.1, N2-02;
// worker/vitest.modules.config.ts `setupFiles`). TEST-ONLY.
//
// - `WebSocketPair`: workerd's global, in memory, with the memoryLink socket
//   semantics of the fake Jetstream (packages/atproto/test-support/
//   fake-jetstream.ts `MemoryWebSocket`): events queue until `accept()` and
//   are dispatched in order; `send` copies its data (binary arrives as an
//   ArrayBuffer); `close(code, reason)` delivers a close event with that code
//   (1005 when none) to the peer, and an end that has sent its close refuses
//   further sends. One difference, workerd's: an event is delivered on a later
//   task (a zero-delay timer, the one `flush()` in
//   worker/test/fixtures/jetstream-server.ts waits for), never in the
//   microtasks of the code that sent it, so `await connect(...)` returns
//   before the replay of the new link arrives, as on workerd. The fixture,
//   through the production connector, runs unchanged on it.
// - `Request`: workerd accepts a ReadableStream body without `duplex`; undici
//   throws "duplex option is required". The global `Request` is replaced by a
//   subclass that defaults `duplex: 'half'` for such an init and is otherwise
//   undici's Request (worker/test/http/params.test.ts builds streamed bodies).
//   Node-only source (worker/src/node/**) sets `duplex` itself and is tested
//   by the worker-node project, which has no shim.
// - After each test file, the `cloudflare:*` shim closes every Durable Object
//   connection and removes the file's temporary database directory.

import { afterAll } from 'vitest';
import { shimTeardown } from './cloudflare-workers-shim';

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

function copyData(data: string | ArrayBufferLike | ArrayBufferView): string | ArrayBuffer {
  if (typeof data === 'string') return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
  return new Uint8Array(data).slice().buffer;
}

function closeEvent(code: number, reason: string): Event {
  return Object.assign(new Event('close'), { code, reason, wasClean: true });
}

function messageEvent(data: string | ArrayBuffer): Event {
  return new MessageEvent('message', { data });
}

/** One end of an in-memory workerd WebSocket pair (see the header). */
export class WorkerdWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = WS_OPEN;
  static readonly CLOSING = WS_CLOSING;
  static readonly CLOSED = WS_CLOSED;
  readyState: number = WS_OPEN;
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  readonly bufferedAmount = 0;
  readonly extensions = '';
  readonly protocol = '';
  readonly url: string | null = null;
  /** The close code this end sent, or null. */
  sentCloseCode: number | null = null;
  private peer: WorkerdWebSocket | null = null;
  private accepted = false;
  private receivedClose = false;
  private scheduled = false;
  private readonly inbox: Event[] = [];

  static link(a: WorkerdWebSocket, b: WorkerdWebSocket): void {
    a.peer = b;
    b.peer = a;
  }

  accept(): void {
    if (this.accepted) throw new TypeError('WebSocket already accepted');
    this.accepted = true;
    this.schedule();
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.sentCloseCode !== null) throw new TypeError("Can't call WebSocket send() after close().");
    this.peer?.enqueue(messageEvent(copyData(data)));
  }

  close(code?: number, reason?: string): void {
    if (this.sentCloseCode !== null) return;
    const sent = code ?? 1005;
    this.sentCloseCode = sent;
    this.readyState = this.receivedClose ? WS_CLOSED : WS_CLOSING;
    this.peer?.enqueue(closeEvent(sent, reason ?? ''));
  }

  private enqueue(ev: Event): void {
    if (this.readyState === WS_CLOSED) return;
    this.inbox.push(ev);
    this.schedule();
  }

  /** Delivers every queued event, in order, on one later task. */
  private schedule(): void {
    if (!this.accepted || this.scheduled || this.inbox.length === 0) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      for (const ev of this.inbox.splice(0)) {
        if (ev.type === 'close') {
          this.receivedClose = true;
          this.readyState = this.sentCloseCode !== null ? WS_CLOSED : WS_CLOSING;
        }
        this.dispatchEvent(ev);
      }
    }, 0);
  }
}

/** workerd's `WebSocketPair` shape: `0` is the client end, `1` the server end. */
export class WorkerdWebSocketPair {
  readonly 0: WorkerdWebSocket;
  readonly 1: WorkerdWebSocket;
  constructor() {
    this[0] = new WorkerdWebSocket();
    this[1] = new WorkerdWebSocket();
    WorkerdWebSocket.link(this[0], this[1]);
  }
}

if (!('WebSocketPair' in globalThis)) {
  Object.defineProperty(globalThis, 'WebSocketPair', {
    value: WorkerdWebSocketPair,
    configurable: true,
    writable: true,
  });
}

const NodeRequest = globalThis.Request;
const isStream = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && typeof (body as ReadableStream).getReader === 'function';

/** workerd's Request: a streamed body needs no `duplex`. */
class WorkerdRequest extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init !== undefined && isStream(init.body) && !('duplex' in init)) {
      super(input, { ...init, duplex: 'half' } as RequestInit);
    } else {
      super(input, init);
    }
  }
}

if (!Object.hasOwn(globalThis.Request, 'workerdShim')) {
  Object.defineProperty(WorkerdRequest, 'workerdShim', { value: true });
  globalThis.Request = WorkerdRequest as typeof Request;
}

afterAll(() => {
  shimTeardown();
});
