// A minimal HTTP/1.1 server on raw sockets, shaped to exactly what this forge's handlers
// use — nothing more. node:http's request/response machinery (header objects, agent and
// timeout bookkeeping, chunked framing decisions) costs more per request than the forge's
// own work on the small exchanges the suite makes thousands of times, so the wire layer
// is kept to: parse a request head, read a content-length or chunked body, hand the
// handlers a request whose body is already whole, and write each response as one buffer
// with an explicit content-length. Keep-alive, 100-continue and pipelined leftovers in
// the receive buffer are handled; every response this codebase sends is a single end(),
// which is what makes the one-buffer write safe.

import { EventEmitter } from 'node:events';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';

const EMPTY = Buffer.alloc(0);
const MAX_HEAD_BYTES = 64 * 1024;

const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** The request the handlers see: method, raw url, lower-cased headers, the whole body. */
export class RawRequest extends EventEmitter {
  method = '';
  url = '/';
  headers: Record<string, string> = Object.create(null) as Record<string, string>;
  /** The complete request body, parsed before dispatch; http.ts readBody returns it as is. */
  bodyBuffer: Buffer = EMPTY;
  private readonly socket: Socket;

  constructor(socket: Socket) {
    super();
    this.socket = socket;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** The response the handlers see: writeHead records, end writes head + body in one go. */
export class RawResponse extends EventEmitter {
  headersSent = false;
  private finished = false;
  private status = 200;
  private readonly headers: Array<[string, string]> = [];
  private readonly socket: Socket;
  private readonly closeAfter: boolean;
  private readonly onFlushed: () => void;

  constructor(socket: Socket, closeAfter: boolean, onFlushed: () => void) {
    super();
    this.socket = socket;
    this.closeAfter = closeAfter;
    this.onFlushed = onFlushed;
  }

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) this.headers.push([name, String(value)]);
    this.headersSent = true;
    return this;
  }

  end(data?: string | Buffer): void {
    if (this.finished) return;
    this.finished = true;
    this.headersSent = true;
    const body = data === undefined ? EMPTY : typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const noBody = this.status === 204 || (this.status >= 100 && this.status < 200);
    let head = `HTTP/1.1 ${this.status} ${REASONS[this.status] ?? ''}\r\n`;
    let hasLength = false;
    for (const [name, value] of this.headers) {
      if (name.toLowerCase() === 'content-length') hasLength = true;
      head += `${name}: ${value}\r\n`;
    }
    if (!noBody && !hasLength) head += `content-length: ${body.length}\r\n`;
    if (this.closeAfter) head += 'connection: close\r\n';
    head += '\r\n';
    const headBuf = Buffer.from(head, 'latin1');
    const out = noBody || body.length === 0 ? headBuf : Buffer.concat([headBuf, body]);
    if (this.socket.destroyed) {
      this.onFlushed();
      return;
    }
    this.socket.write(out, () => {
      if (this.closeAfter) this.socket.end();
      this.onFlushed();
    });
  }
}

interface ParsedHead {
  method: string;
  url: string;
  version11: boolean;
  headers: Record<string, string>;
  contentLength: number | null;
  chunked: boolean;
  keepAlive: boolean;
  expectContinue: boolean;
}

/** Parse one request head (without its trailing CRLFCRLF); null when it is not a request. */
function parseHead(text: string): ParsedHead | null {
  const lines = text.split('\r\n');
  const first = lines[0] as string;
  const sp1 = first.indexOf(' ');
  const sp2 = first.lastIndexOf(' ');
  if (sp1 <= 0 || sp2 <= sp1) return null;
  const method = first.slice(0, sp1);
  const url = first.slice(sp1 + 1, sp2);
  const version11 = first.slice(sp2 + 1) === 'HTTP/1.1';
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers[name];
    headers[name] = existing === undefined ? value : `${existing}, ${value}`;
  }
  const lengthRaw = headers['content-length'];
  const contentLength = lengthRaw === undefined ? null : Number.parseInt(lengthRaw, 10);
  const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
  const connection = (headers['connection'] ?? '').toLowerCase();
  const keepAlive = version11 ? !connection.includes('close') : connection.includes('keep-alive');
  return {
    method,
    url,
    version11,
    headers,
    contentLength: contentLength !== null && Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
    chunked,
    keepAlive,
    expectContinue: (headers['expect'] ?? '').toLowerCase() === '100-continue',
  };
}

/** Decode a chunked body starting at `start`; null while more bytes are still needed. */
function decodeChunked(buf: Buffer, start: number): { body: Buffer; next: number } | null {
  const parts: Buffer[] = [];
  let offset = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const sizeText = buf.toString('latin1', offset, lineEnd);
    const semi = sizeText.indexOf(';');
    const size = Number.parseInt((semi < 0 ? sizeText : sizeText.slice(0, semi)).trim(), 16);
    if (!Number.isFinite(size) || size < 0) return { body: EMPTY, next: buf.length };
    offset = lineEnd + 2;
    if (size === 0) {
      // Trailer lines run to an empty line.
      for (;;) {
        const end = buf.indexOf('\r\n', offset);
        if (end < 0) return null;
        if (end === offset) return { body: parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts), next: end + 2 };
        offset = end + 2;
      }
    }
    if (buf.length < offset + size + 2) return null;
    parts.push(buf.subarray(offset, offset + size));
    offset += size + 2;
  }
}

/** One connection: an incremental parser feeding the dispatcher one request at a time. */
class Connection {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private busy = false;
  private closed = false;
  private readonly socket: Socket;
  private readonly dispatch: (req: RawRequest, res: RawResponse) => Promise<void>;

  constructor(socket: Socket, dispatch: (req: RawRequest, res: RawResponse) => Promise<void>) {
    this.socket = socket;
    this.dispatch = dispatch;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      void this.pump();
    });
    socket.on('error', () => {
      this.closed = true;
    });
    socket.on('close', () => {
      this.closed = true;
    });
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }

  /** The whole receive buffer as one buffer (compacting only when a parse needs it). */
  private flat(): Buffer {
    if (this.chunks.length !== 1) {
      const all = Buffer.concat(this.chunks, this.buffered);
      this.chunks = [all];
    }
    return this.chunks[0] as Buffer;
  }

  private consume(count: number): void {
    this.buffered -= count;
    const all = this.flat();
    const rest = all.subarray(count);
    this.chunks = rest.length > 0 ? [Buffer.from(rest)] : [];
  }

  private async pump(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      for (;;) {
        if (this.closed || this.buffered === 0) return;
        const buf = this.flat();
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd < 0) {
          if (this.buffered > MAX_HEAD_BYTES) this.destroy();
          return;
        }
        const head = parseHead(buf.toString('latin1', 0, headEnd));
        if (head === null) {
          this.destroy();
          return;
        }
        const bodyStart = headEnd + 4;
        if (head.expectContinue && !this.socket.destroyed) this.socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        let body: Buffer = EMPTY;
        let next = bodyStart;
        if (head.chunked) {
          const decoded = decodeChunked(buf, bodyStart);
          if (decoded === null) return; // wait for more bytes
          body = decoded.body;
          next = decoded.next;
        } else {
          const length = head.contentLength ?? 0;
          if (this.buffered < bodyStart + length) return; // wait for more bytes
          if (length > 0) body = Buffer.from(buf.subarray(bodyStart, bodyStart + length));
          next = bodyStart + length;
        }
        this.consume(next);
        const req = new RawRequest(this.socket);
        req.method = head.method;
        req.url = head.url;
        req.headers = head.headers;
        req.bodyBuffer = body;
        const flushed = new Promise<void>((resolve) => {
          const res = new RawResponse(this.socket, !head.keepAlive, resolve);
          void this.dispatch(req, res);
        });
        await flushed;
        if (!head.keepAlive) {
          this.closed = true;
          return;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

/** The server main.ts runs: listen on an ephemeral port, dispatch, close. */
export class RawServer extends EventEmitter {
  private readonly tcp = createTcpServer();
  private readonly connections = new Set<Connection>();

  constructor(dispatch: (req: RawRequest, res: RawResponse) => Promise<void>) {
    super();
    this.tcp.on('connection', (socket: Socket) => {
      const conn = new Connection(socket, dispatch);
      this.connections.add(conn);
      socket.on('close', () => {
        this.connections.delete(conn);
      });
    });
    this.tcp.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  listen(port: number, callback: () => void): void {
    this.tcp.listen(port, callback);
  }

  address(): AddressInfo | string | null {
    return this.tcp.address();
  }

  close(): void {
    for (const conn of this.connections) conn.destroy();
    this.connections.clear();
    this.tcp.close();
  }
}
