// HTTP plumbing shared by every surface: body reading, JSON answers with the headers the
// protocol checks require (a request id on every API reply, the OAuth scopes on the root),
// the bearer-token gate, and the {message} error shape.
//
// The timed workloads issue thousands of small requests against this plumbing, so the hot
// helpers avoid repeat work: the expected Authorization header is resolved once, a JSON
// answer is encoded to bytes exactly once (its length is the buffer's, never re-measured),
// the request id is a plain counter, a one-chunk body is returned without a concat copy,
// and a path segment is only decodeURIComponent'd when it actually carries a '%'.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeError } from './forge.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** Answer with a JSON body and a fresh X-GitHub-Request-Id. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  sendText(res, status, body === undefined ? '' : `${JSON.stringify(body)}\n`, headers);
}

/** Answer with a body that is already serialized JSON text (the sendJson wire shape). */
export function sendText(res: ServerResponse, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void {
  const buf = Buffer.from(text, 'utf8');
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': `GHF-${requestSeq.toString(36).toUpperCase()}`,
    ...headers,
  });
  res.end(buf);
}

/** Answer with no body at all (a 204 delete). */
export function sendEmpty(res: ServerResponse, status: number): void {
  requestSeq += 1;
  res.writeHead(status, { 'x-github-request-id': `GHF-${requestSeq.toString(36).toUpperCase()}` });
  res.end();
}

/** The GitHub error shape: a JSON object with a string message. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

const EMPTY_BODY = Buffer.alloc(0);

/** Read a whole request body (bodies in this contest are small; the cap is generous). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  // A transport that parses each request whole before dispatch may hand the body over
  // directly; otherwise it is read from the stream.
  const preloaded = (req as unknown as { bodyBuffer?: Buffer }).bodyBuffer;
  if (preloaded !== undefined) return Promise.resolve(preloaded);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new ForgeError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) resolve(EMPTY_BODY);
      else if (chunks.length === 1) resolve(chunks[0] as Buffer);
      else resolve(Buffer.concat(chunks, total));
    });
    req.on('error', reject);
  });
}

/** Parse a JSON body; a malformed body is the protocol group's 400. */
export function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
  return value as Record<string, unknown>;
}

/**
 * The expected Authorization header, resolved once: the trial's token is in the process's
 * environment before the server binds, so it cannot change under a running forge. Null
 * while the process was given no token (any non-empty bearer credential then passes).
 */
let expectedAuth: string | null | undefined;

/** The bearer gate: the trial's token, when the process was given one, is the only credential. */
export function authorized(req: IncomingMessage): boolean {
  if (expectedAuth === undefined) {
    const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    expectedAuth = token === '' ? null : `Bearer ${token}`;
  }
  const header = req.headers.authorization ?? '';
  if (expectedAuth === null) return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
  return header === expectedAuth;
}

/** Decode one path segment (a branch name's %2F becomes a slash inside the segment). */
export function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a request path into decoded segments. */
export function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '').map(decodeSegment);
}
