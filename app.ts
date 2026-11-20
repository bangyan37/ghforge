// The forge's HTTP surface, all of it over one store (forge.ts): a health probe, git smart
// HTTP at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL v4 at /api/graphql and the MCP
// endpoint at /mcp. Anything else is a JSON 404 with {message: "Not Found"} — never HTML.
// main.ts owns the entry <-> env lifecycle; this file is only the server.
//
// The wire layer is server.ts, a minimal HTTP/1.1 server on raw sockets: the suite makes
// thousands of small requests, and node:http's per-request machinery costs more than the
// handlers' own work at that scale. Dispatch goes by the path first, because the four
// surfaces own disjoint paths: a request is routed to the one surface that can answer it
// instead of being offered to each in turn — the routing outcome for every path is the
// same as offering it to all four in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, ForgeError } from './forge.ts';
import { handleGitHttp } from './gitHttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { sendError, sendJson } from './http.ts';
import { RawServer, type RawRequest, type RawResponse } from './server.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function urlOf(url: string): URL {
  try {
    return new URL(url, 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

export function createApp(): RawServer {
  const forge = new Forge();
  const dispatch = async (rawReq: RawRequest, rawRes: RawResponse): Promise<void> => {
    const req = rawReq as unknown as IncomingMessage;
    const res = rawRes as unknown as ServerResponse;
    const url = urlOf(rawReq.url);
    const path = url.pathname;
    try {
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/mcp') {
        await handleMcp(forge, req, res, url);
        return;
      }
      if (path === '/api/graphql') {
        await handleGraphql(forge, req, res, url);
        return;
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        await handleRest(forge, req, res, url);
        return;
      }
      if (await handleGitHttp(forge, req, res, url)) return;
      sendError(res, 404, 'Not Found');
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof ForgeError) {
        sendError(res, err.status, err.message);
        return;
      }
      sendError(res, 500, err instanceof Error ? err.message : 'Internal error');
    }
  };
  return new RawServer(dispatch);
}
