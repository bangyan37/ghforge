// The MCP endpoint: streamable-HTTP JSON-RPC with both protocol eras the suite speaks —
// the 2026-07-28 revision's server/discover and the legacy initialize handshake — plus
// tools/list and tools/call for the six forge tools. The tools act on the same store as
// REST (their results are the REST shapes), so an object made here is the same object there.
// A tools/list answer is a constant: byte-identical on every call.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeError, VIEWER, type Forge } from './forge.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { authorized, readBody } from './http.ts';

const SERVER_INFO = { name: 'ghforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'ghforge-session';

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the given user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

interface RpcRequest {
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requiredArgs(tool: (typeof TOOLS)[number], args: Record<string, unknown>): string | null {
  for (const key of tool.inputSchema.required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return key;
  }
  return null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new RpcFailure(-32601, `Tool ${name} not found`);
  const missing = requiredArgs(tool, args);
  if (missing !== null) throw new RpcFailure(-32602, `Missing required argument: ${missing}`);
  const str = (key: string): string => String(args[key] ?? '');
  try {
    switch (name) {
      case 'create_repo': {
        const existing = forge.findRepo(str('owner') === '' ? VIEWER.login : str('owner'), str('name'));
        if (existing !== undefined) return toolResult(repoJson(existing));
        const repo = forge.createRepo(str('owner') === '' ? VIEWER.login : str('owner'), str('name'), {
          description: str('description'),
          isPrivate: args.private === true,
        });
        return toolResult(repoJson(repo));
      }
      case 'get_repo': {
        return toolResult(repoJson(forge.getRepo(str('owner'), str('repo'))));
      }
      case 'create_issue': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        const issue = forge.createIssue(repo, { title: str('title'), body: str('body') });
        return toolResult(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        const state = typeof args.state === 'string' ? args.state : 'open';
        return toolResult(forge.listIssues(repo, state, 'asc').map((issue) => issueJson(repo, issue)));
      }
      case 'create_pull_request': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        const pull = forge.createPull(repo, { title: str('title'), body: str('body'), head: str('head'), base: str('base') });
        return toolResult(pullJson(forge, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        const pull = forge.getPull(repo, Number(args.pull_number));
        const sha = forge.mergePull(repo, pull, 'squash');
        return toolResult({ ...pullJson(forge, repo, pull), sha, merged: true });
      }
      default:
        throw new RpcFailure(-32601, `Tool ${name} not found`);
    }
  } catch (err) {
    if (err instanceof ForgeError) return toolFailure(err.message);
    throw err;
  }
}

class RpcFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function dispatch(forge: Forge, request: RpcRequest): Record<string, unknown> | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params ?? {};
  const isNotification = request.id === undefined;
  const answer = (value: Record<string, unknown>): Record<string, unknown> | null => (isNotification ? null : value);
  switch (method) {
    case 'server/discover':
      return answer(
        rpcResult(request.id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      );
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return answer(rpcResult(request.id, { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: SERVER_INFO }));
    }
    case 'ping':
      return answer(rpcResult(request.id, {}));
    case 'tools/list':
      return answer(rpcResult(request.id, { tools: TOOLS }));
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      try {
        return answer(rpcResult(request.id, callTool(forge, name, args)));
      } catch (err) {
        if (err instanceof RpcFailure) return answer(rpcError(request.id, err.code, err.message));
        throw err;
      }
    }
    default:
      if (method.startsWith('notifications/')) return null;
      return answer(rpcError(request.id, -32601, `Method not found: ${method}`));
  }
}

function sendRpc(res: ServerResponse, status: number, payload: unknown): void {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'mcp-session-id': SESSION_ID,
  });
  res.end(text);
}

/** Route /mcp; returns false outside the path. */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/mcp') return false;
  if (!authorized(req)) {
    sendRpc(res, 401, { message: 'Unauthorized' });
    return true;
  }
  if (req.method === 'GET' || req.method === 'DELETE') {
    // No server-initiated stream is offered; the stateless POST channel is the transport.
    sendRpc(res, 405, rpcError(null, -32601, 'Method not allowed'));
    return true;
  }
  const raw = (await readBody(req)).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const idMatch = /"id"\s*:\s*(\d+|"[^"]*")/.exec(raw);
    let id: unknown = null;
    if (idMatch !== null) {
      try {
        id = JSON.parse(idMatch[1] as string);
      } catch {
        id = null;
      }
    }
    sendRpc(res, 400, rpcError(id, -32700, 'Parse error'));
    return true;
  }
  if (Array.isArray(parsed)) {
    const answers: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      const answer = dispatch(forge, (entry ?? {}) as RpcRequest);
      if (answer !== null) answers.push(answer);
    }
    sendRpc(res, 200, answers);
    return true;
  }
  const answer = dispatch(forge, (parsed ?? {}) as RpcRequest);
  if (answer === null) {
    res.writeHead(202, { 'mcp-session-id': SESSION_ID });
    res.end();
    return true;
  }
  sendRpc(res, 200, answer);
  return true;
}
