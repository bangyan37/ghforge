// HTTP plumbing shared by every surface: body reading, JSON answers with the headers the
// protocol checks require (a request id on every API reply, the OAuth scopes on the root),
// the bearer-token gate, and the {message} error shape.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeError } from './forge.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** Answer with a JSON body and a fresh X-GitHub-Request-Id. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `GHF-${requestSeq.toString(36).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
    ...headers,
  });
  res.end(text);
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

/** Read a whole request body (bodies in this contest are small; the cap is generous). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

/** The bearer gate: the trial's token, when the process was given one, is the only credential. */
export function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (expected === '') return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
  return header === `Bearer ${expected}`;
}

/** Decode one path segment (a branch name's %2F becomes a slash inside the segment). */
export function decodeSegment(segment: string): string {
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
