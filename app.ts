// The forge's HTTP surface, all of it over one store (forge.ts): a health probe, git smart
// HTTP at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL v4 at /api/graphql and the MCP
// endpoint at /mcp. Anything else is a JSON 404 with {message: "Not Found"} — never HTML.
// main.ts owns the entry <-> env lifecycle; this file is only the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, ForgeError } from './forge.ts';
import { handleGitHttp } from './gitHttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { sendError, sendJson } from './http.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const url = urlOf(req);
      try {
        if (url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (await handleMcp(forge, req, res, url)) return;
        if (await handleGraphql(forge, req, res, url)) return;
        if (await handleRest(forge, req, res, url)) return;
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
    })();
  });
  return server;
}
