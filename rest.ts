// The REST v3 surface: the API root and meta, the viewer, repositories and their branches,
// commits and contents, labels, issues and comments, and pull requests with their files and
// merges. Shapes follow GitHub's: the fields the suite reads are the fields GitHub sends,
// statuses are exact (201 a create, 200 an update, 204 a delete, 404/409/422 by their names),
// and every error body is {message}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './git.ts';
import { ForgeError, touchRefs, VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './forge.ts';
import { authorized, parseJsonBody, pathSegments, readBody, sendEmpty, sendError, sendJson, sendText } from './http.ts';

// ------------------------------------------------------------------ serializers

/** The viewer's JSON shape, built once: it never varies, and serializers only read it. */
const USER_JSON: Record<string, unknown> = { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };

export function userJson(): Record<string, unknown> {
  return USER_JSON;
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '', default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/**
 * An issue's serialized REST body, cached on the issue itself. The stamp is the issue's
 * updatedAt plus its comment count: every mutation path (REST patch, a new comment, the
 * GraphQL close) moves updatedAt through the forge's strictly increasing clock, and a
 * label's colour cannot change once the label exists, so a matching stamp means the
 * cached text is exactly what issueJson would build now. The read workload asks for one
 * issue thousands of times; this turns those answers into a memory copy.
 */
export function issueJsonText(repo: RepoRec, issue: IssueRec): string {
  const stamp = `${issue.updatedAt}|${issue.comments.length}`;
  const cached = issue.jsonCache;
  if (cached !== undefined && cached.stamp === stamp) return cached.text;
  const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
  issue.jsonCache = { stamp, text };
  return text;
}

export function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: userJson(), created_at: comment.createdAt, updated_at: comment.createdAt };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = forge.resolveCommit(repo, `refs/heads/${pull.headRef}`) ?? '';
  const baseSha = forge.resolveCommit(repo, `refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, repo: { full_name: `${repo.owner}/${repo.name}` } },
    base: { ref: pull.baseRef, sha: baseSha, repo: { full_name: `${repo.owner}/${repo.name}` } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ------------------------------------------------------------------ helpers

interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
}

function queryInt(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Slice one page out of a list and build the Link header GitHub paginates with. */
function paginate<T>(ctx: Ctx, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(queryInt(ctx.url, 'per_page', 30), 100);
  const page = queryInt(ctx.url, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? 'localhost';
    const next = new URL(`http://${host}${ctx.url.pathname}`);
    for (const [key, value] of ctx.url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(next);
    last.searchParams.set('page', String(lastPage));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, headers };
}

async function bodyOf(ctx: Ctx): Promise<Record<string, unknown>> {
  return parseJsonBody(await readBody(ctx.req));
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

// ------------------------------------------------------------------ routes

async function routeRoot(ctx: Ctx): Promise<void> {
  sendJson(
    ctx.res,
    200,
    {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues',
      pull_request_url: '/api/v3/repos/{owner}/{repo}/pulls',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

async function routeUserRepos(ctx: Ctx): Promise<void> {
  if (ctx.req.method === 'POST') {
    const body = await bodyOf(ctx);
    const name = str(body, 'name');
    if (name === undefined || name === '') throw new ForgeError(422, 'Validation Failed: name is required');
    const repo = ctx.forge.createRepo(VIEWER.login, name, {
      description: str(body, 'description') ?? '',
      isPrivate: body.private === true,
    });
    sendJson(ctx.res, 201, repoJson(repo));
    return;
  }
  if (ctx.req.method === 'GET') {
    const { page, headers } = paginate(ctx, ctx.forge.listRepos(VIEWER.login));
    sendJson(ctx.res, 200, page.map(repoJson), headers);
    return;
  }
  throw new ForgeError(404, 'Not Found');
}

async function routeRepo(ctx: Ctx, repo: RepoRec, rest: string[]): Promise<void> {
  const { forge, req, res, url } = ctx;
  const head = rest[0];
  if (rest.length === 0) {
    if (req.method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (req.method === 'PATCH') {
      const body = await bodyOf(ctx);
      const description = str(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      const defaultBranch = str(body, 'default_branch');
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      repo.updatedAt = forge.nowIso();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (req.method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      sendEmpty(res, 204);
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }
  if (head === 'branches') {
    if (rest.length === 1 && req.method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches);
      return;
    }
    if (rest.length >= 2 && req.method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) throw new ForgeError(404, 'Not Found');
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }
  if (head === 'commits') {
    if (rest.length === 1 && req.method === 'GET') {
      const startRef = url.searchParams.get('sha') ?? repo.defaultBranch;
      const start = forge.resolveCommit(repo, startRef);
      if (start === null) {
        sendJson(res, 200, []);
        return;
      }
      const commits = forge.listCommits(repo, start).map((commit) => ({
        sha: commit.sha,
        commit: {
          message: commit.message,
          author: { name: commit.author.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(commit.author)?.[1] ?? '' },
          committer: { name: commit.committer.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(commit.committer)?.[1] ?? '' },
        },
        parents: commit.parents.map((sha) => ({ sha })),
      }));
      const { page, headers } = paginate(ctx, commits);
      sendJson(res, 200, page, headers);
      return;
    }
    if (rest.length === 2 && req.method === 'GET') {
      const object = repo.objects.get(rest[1] as string);
      if (object === undefined || object.type !== 'commit') throw new ForgeError(404, 'Not Found');
      const commit = parseCommit(object.data);
      sendJson(res, 200, { sha: rest[1], commit: { message: commit.message, tree: { sha: commit.tree } }, parents: commit.parents.map((sha) => ({ sha })) });
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && req.method === 'POST') {
      const body = await bodyOf(ctx);
      const ref = str(body, 'ref') ?? '';
      const sha = str(body, 'sha') ?? '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) throw new ForgeError(422, 'Validation Failed: invalid ref or sha');
      if (repo.refs.has(ref)) throw new ForgeError(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      touchRefs(repo);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    if (rest.length === 2 && req.method === 'GET') {
      sendJson(res, 200, [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } })));
      return;
    }
    if (rest.length >= 3 && req.method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) throw new ForgeError(404, 'Not Found');
      sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (req.method === 'PUT') {
      const body = await bodyOf(ctx);
      const content = str(body, 'content');
      if (content === undefined) throw new ForgeError(422, 'Validation Failed: content is required');
      const branch = str(body, 'branch') ?? repo.defaultBranch;
      const result = forge.putFile(repo, branch, path, Buffer.from(content, 'base64'), str(body, 'message') ?? 'Update file', str(body, 'sha'));
      sendJson(res, result.created ? 201 : 200, {
        content: { name: path.split('/').pop() ?? path, path, sha: result.blobSha, size: Buffer.from(content, 'base64').length, encoding: 'base64', type: 'file' },
        commit: { sha: result.commitSha },
      });
      return;
    }
    if (req.method === 'GET') {
      const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
      const found = forge.readPath(repo, ref, path);
      if (found === null) throw new ForgeError(404, 'Not Found');
      if (found.kind === 'dir') {
        sendJson(res, 200, found.entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.oid })));
        return;
      }
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: found.data.toString('base64'),
        sha: found.oid,
        size: found.data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
      return;
    }
    if (req.method === 'DELETE') {
      const body = await bodyOf(ctx);
      const branch = str(body, 'branch') ?? repo.defaultBranch;
      const result = forge.deleteFile(repo, branch, path, str(body, 'message') ?? 'Delete file', str(body, 'sha'));
      sendJson(res, 200, { content: null, commit: { sha: result.commitSha } });
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }
  if (head === 'labels') {
    if (rest.length === 1 && req.method === 'POST') {
      const body = await bodyOf(ctx);
      const name = str(body, 'name');
      if (name === undefined || name === '') throw new ForgeError(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) throw new ForgeError(422, 'Validation Failed: label already exists');
      const label = { name, color: str(body, 'color') ?? 'ededed' };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (rest.length === 1 && req.method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }
  if (head === 'issues') {
    if (rest.length === 1 && req.method === 'POST') {
      const body = await bodyOf(ctx);
      const title = str(body, 'title');
      if (title === undefined) throw new ForgeError(422, 'Validation Failed: title is required');
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      const labels = rawLabels.map((entry) => (typeof entry === 'string' ? entry : String((entry as { name?: unknown }).name ?? '')));
      const issue = forge.createIssue(repo, { title, body: str(body, 'body') ?? '', labels });
      sendText(res, 201, issueJsonText(repo, issue));
      return;
    }
    if (rest.length === 1 && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc';
      const { page, headers } = paginate(ctx, forge.listIssues(repo, state, direction));
      sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), headers);
      return;
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (rest.length === 2 && req.method === 'GET') {
      sendText(res, 200, issueJsonText(repo, forge.getIssue(repo, number)));
      return;
    }
    if (rest.length === 2 && req.method === 'PATCH') {
      const body = await bodyOf(ctx);
      const issue = forge.getIssue(repo, number);
      const title = str(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = str(body, 'body');
      if (text !== undefined) issue.body = text;
      const state = str(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.map((entry) => (typeof entry === 'string' ? entry : String((entry as { name?: unknown }).name ?? '')));
        for (const label of labels) if (!repo.labels.has(label)) throw new ForgeError(422, `Validation Failed: label "${label}" does not exist`);
        issue.labels = labels;
      }
      issue.updatedAt = forge.nowIso();
      sendText(res, 200, issueJsonText(repo, issue));
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments' && req.method === 'POST') {
      const body = await bodyOf(ctx);
      const comment = forge.addComment(repo, number, str(body, 'body') ?? '');
      sendJson(res, 201, commentJson(comment));
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments' && req.method === 'GET') {
      const issue = forge.getIssue(repo, number);
      sendJson(res, 200, issue.comments.map(commentJson));
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }
  if (head === 'pulls') {
    if (rest.length === 1 && req.method === 'POST') {
      const body = await bodyOf(ctx);
      const stripPrefix = (value: string): string => (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value);
      const head2 = stripPrefix(str(body, 'head') ?? '');
      const base = stripPrefix(str(body, 'base') ?? repo.defaultBranch);
      const pull = forge.createPull(repo, { title: str(body, 'title') ?? '', body: str(body, 'body') ?? '', head: head2, base });
      sendJson(res, 201, pullJson(forge, repo, pull));
      return;
    }
    if (rest.length === 1 && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const { page, headers } = paginate(ctx, forge.listPulls(repo, state));
      sendJson(res, 200, page.map((pull) => pullJson(forge, repo, pull)), headers);
      return;
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (rest.length === 2 && req.method === 'GET') {
      sendJson(res, 200, pullJson(forge, repo, forge.getPull(repo, number)));
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && req.method === 'GET') {
      const pull = forge.getPull(repo, number);
      sendJson(res, 200, forge.pullFiles(repo, pull));
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && req.method === 'PUT') {
      const body = await bodyOf(ctx);
      const pull = forge.getPull(repo, number);
      const method = str(body, 'merge_method') ?? 'merge';
      const sha = forge.mergePull(repo, pull, method === 'squash' ? 'squash' : 'merge');
      sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }
  throw new ForgeError(404, 'Not Found');
}

/** Route one /api/v3 request; returns false when the path is outside the API. */
export async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const segments = pathSegments(url.pathname);
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  if (!authorized(req)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  const ctx: Ctx = { forge, req, res, url, segments };
  const rest = segments.slice(2);
  try {
    if (rest.length === 0) {
      if (req.method === 'GET') await routeRoot(ctx);
      else throw new ForgeError(404, 'Not Found');
      return true;
    }
    if (rest[0] === 'meta' && rest.length === 1 && req.method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }
    if (rest[0] === 'user' && rest.length === 1 && req.method === 'GET') {
      sendJson(res, 200, userJson());
      return true;
    }
    if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
      await routeUserRepos(ctx);
      return true;
    }
    if (rest[0] === 'repos' && rest.length >= 3) {
      const repo = forge.getRepo(rest[1] as string, rest[2] as string);
      await routeRepo(ctx, repo, rest.slice(3));
      return true;
    }
    throw new ForgeError(404, 'Not Found');
  } catch (err) {
    if (err instanceof ForgeError) {
      sendError(res, err.status, err.message);
      return true;
    }
    throw err;
  }
}
