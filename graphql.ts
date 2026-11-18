// The GraphQL v4 surface: a small parser and executor for the documents gh and
// github-mcp-server actually send — viewer, repository fields, the __type feature probes,
// issue and pull-request reads with cursor pagination, and the create/close/merge/comment
// mutations — executed against the same forge store as REST, so the two views never drift.
// Global ids are opaque base64, stable across reads, and round-trip through node(id:).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeError, VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './forge.ts';
import { authorized, readBody, sendError, sendJson } from './http.ts';

// ------------------------------------------------------------------ global ids

export function globalId(type: string, ...parts: Array<string | number>): string {
  return Buffer.from(`ghf:${type}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'ghf' || parts.length < 3) return null;
    return { type: parts[1] as string, parts: parts.slice(2) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selectionSet: SelectionItem[] | null;
}

type SelectionItem = FieldNode | { kind: 'fragment'; typeCondition: string; selectionSet: SelectionItem[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionItem[];
}

function tokenize(input: string): Array<{ t: string; v: string }> {
  const tokens: Array<{ t: string; v: string }> = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ t: '...', v: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ t: ch, v: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        tokens.push({ t: 'str', v: input.slice(i + 3, end === -1 ? input.length : end) });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      tokens.push({ t: 'num', v: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      tokens.push({ t: 'name', v: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: Array<{ t: string; v: string }>;
  private pos = 0;
  constructor(input: string) {
    this.tokens = tokenize(input);
  }
  private peek(): { t: string; v: string } | undefined {
    return this.tokens[this.pos];
  }
  private next(): { t: string; v: string } {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expect(t: string): void {
    const token = this.next();
    if (token.t !== t) throw new Error(`expected ${t}, got ${token.v}`);
  }
  private skipType(): void {
    // a type reference: Name, [Type], with optional !
    if (this.peek()?.t === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek()?.t === '!') this.next();
  }
  private parseValue(): Value {
    const token = this.next();
    if (token.t === '$') {
      const name = this.next();
      return { kind: 'var', name: name.v };
    }
    if (token.t === 'str') return { kind: 'str', value: token.v };
    if (token.t === 'num') return { kind: 'num', value: Number(token.v) };
    if (token.t === '[') {
      const values: Value[] = [];
      while (this.peek()?.t !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.t === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek()?.t !== '}') {
        const name = this.next().v;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.t === 'name') {
      if (token.v === 'true') return { kind: 'bool', value: true };
      if (token.v === 'false') return { kind: 'bool', value: false };
      if (token.v === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.v };
    }
    throw new Error(`unexpected value token ${token.v}`);
  }
  private parseSelectionSet(): SelectionItem[] {
    this.expect('{');
    const items: SelectionItem[] = [];
    while (this.peek()?.t !== '}') {
      if (this.peek()?.t === '...') {
        this.next();
        const on = this.next();
        if (on.v !== 'on') throw new Error('named fragments are not supported');
        const typeCondition = this.next().v;
        items.push({ kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      let nameToken = this.next();
      let alias: string | null = null;
      if (this.peek()?.t === ':') {
        this.next();
        alias = nameToken.v;
        nameToken = this.next();
      }
      const args: Array<{ name: string; value: Value }> = [];
      if (this.peek()?.t === '(') {
        this.next();
        while (this.peek()?.t !== ')') {
          const argName = this.next().v;
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      // directives are skipped (none of the suite's documents carry one that matters)
      while (this.peek()?.t === '@') {
        this.next();
        this.next();
        if (this.peek()?.t === '(') {
          let depth = 0;
          do {
            const token = this.next();
            if (token.t === '(') depth += 1;
            if (token.t === ')') depth -= 1;
          } while (depth > 0);
        }
      }
      const selectionSet = this.peek()?.t === '{' ? this.parseSelectionSet() : null;
      items.push({ kind: 'field', alias, name: nameToken.v, args, selectionSet });
    }
    this.expect('}');
    return items;
  }
  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.t === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.t === 'name' && (token.v === 'query' || token.v === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek()?.t === 'name') name = this.next().v;
        if (this.peek()?.t === '(') {
          this.next();
          while (this.peek()?.t !== ')') {
            this.expect('$');
            this.next(); // variable name
            this.expect(':');
            this.skipType();
            if (this.peek()?.t === '=') {
              this.next();
              this.parseValue();
            }
          }
          this.expect(')');
        }
        operations.push({ type: token.v, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.t === 'name' && token.v === 'fragment') {
        // fragment definitions: parse and discard (the suite uses inline fragments)
        this.next();
        this.next();
        this.next();
        this.next();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${token.v} in GraphQL document`);
    }
    return operations;
  }
}

// ------------------------------------------------------------------ the schema's field lists

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'resourcePath'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'commits', 'additions', 'deletions', 'changedFiles', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'resourcePath'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'isPrivate', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'resourcePath', 'stargazerCount', 'forkCount'],
  User: ['login', 'id', 'name', 'email', 'url', 'resourcePath'],
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ------------------------------------------------------------------ execution

type Obj = { __type: string; [key: string]: unknown };

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function evalValue(value: Value, ctx: ExecCtx): unknown {
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name];
    case 'str':
      return value.value;
    case 'num':
      return value.value;
    case 'bool':
      return value.value;
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => evalValue(entry, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(node: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of node.args) out[arg.name] = evalValue(arg.value, ctx);
  return out;
}

function userObj(): Obj {
  return { __type: 'User' };
}

function repoObj(repo: RepoRec): Obj {
  return { __type: 'Repository', repo };
}

function issueObj(repo: RepoRec, issue: IssueRec): Obj {
  return { __type: 'Issue', repo, issue };
}

function pullObj(repo: RepoRec, pull: PullRec): Obj {
  return { __type: 'PullRequest', repo, pull };
}

function repoById(forge: Forge, id: number): RepoRec | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

function cursorFor(index: number): string {
  return Buffer.from(`arrayconnection:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^arrayconnection:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

interface Page<T> {
  items: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
  total: number;
}

function paginate<T>(items: readonly T[], args: Record<string, unknown>): Page<T> {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') start = indexFromCursor(args.after) + 1;
  const slice = items.slice(start, start + first);
  return {
    items: slice,
    hasNextPage: start + slice.length < items.length,
    endCursor: slice.length > 0 ? cursorFor(start + slice.length - 1) : null,
    startCursor: slice.length > 0 ? cursorFor(start) : null,
    total: items.length,
  };
}

function connectionObj(type: string, page: Page<Obj>): Obj {
  return { __type: type, page };
}

function resolveField(ctx: ExecCtx, type: string, source: Obj | null, node: FieldNode): unknown {
  const args = argsOf(node, ctx);
  const forge = ctx.forge;
  const unknown = (): null => {
    ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${type}'` });
    return null;
  };
  if (type === 'Query') {
    switch (node.name) {
      case 'viewer':
        return userObj();
      case 'repository': {
        const repo = forge.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoObj(repo);
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = repoById(forge, Number(decoded.parts[0]));
          return repo === null ? null : repoObj(repo);
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const repo = repoById(forge, Number(decoded.parts[0]));
          if (repo === null) return null;
          const number = Number(decoded.parts[1]);
          if (decoded.type === 'Issue') {
            const issue = repo.issues.get(number);
            return issue === undefined ? null : issueObj(repo, issue);
          }
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : pullObj(repo, pull);
        }
        if (decoded.type === 'User') return userObj();
        return null;
      }
      case '__type':
        return { __type: '__Type', name: String(args.name ?? '') };
      case '__schema':
        return { __type: '__Schema' };
      default:
        return unknown();
    }
  }
  if (type === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (node.name) {
      case 'createIssue': {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded !== null && decoded.type === 'Repository' ? repoById(forge, Number(decoded.parts[0])) : null;
        if (repo === null) {
          ctx.errors.push({ message: 'repository not found for createIssue' });
          return null;
        }
        const issue = forge.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        return { __type: 'CreateIssuePayload', issue: issueObj(repo, issue) };
      }
      case 'closeIssue': {
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        const repo = decoded !== null ? repoById(forge, Number(decoded.parts[0])) : null;
        const issue = repo !== null && decoded !== null ? repo.issues.get(Number(decoded.parts[1])) : undefined;
        if (repo === null || issue === undefined) {
          ctx.errors.push({ message: 'issue not found for closeIssue' });
          return null;
        }
        issue.state = 'closed';
        issue.updatedAt = forge.nowIso();
        return { __type: 'CloseIssuePayload', issue: issueObj(repo, issue) };
      }
      case 'createPullRequest': {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded !== null && decoded.type === 'Repository' ? repoById(forge, Number(decoded.parts[0])) : null;
        if (repo === null) {
          ctx.errors.push({ message: 'repository not found for createPullRequest' });
          return null;
        }
        try {
          const pull = forge.createPull(repo, {
            title: String(input.title ?? ''),
            body: String(input.body ?? ''),
            head: String(input.headRefName ?? ''),
            base: String(input.baseRefName ?? repo.defaultBranch),
          });
          return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
        } catch (err) {
          ctx.errors.push({ message: err instanceof Error ? err.message : 'createPullRequest failed' });
          return null;
        }
      }
      case 'mergePullRequest': {
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        const repo = decoded !== null ? repoById(forge, Number(decoded.parts[0])) : null;
        const pull = repo !== null && decoded !== null ? repo.pulls.get(Number(decoded.parts[1])) : undefined;
        if (repo === null || pull === undefined) {
          ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
          return null;
        }
        try {
          const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
          forge.mergePull(repo, pull, method === 'squash' ? 'squash' : 'merge');
          return { __type: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
        } catch (err) {
          ctx.errors.push({ message: err instanceof Error ? err.message : 'mergePullRequest failed' });
          return null;
        }
      }
      case 'addComment': {
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        const repo = decoded !== null ? repoById(forge, Number(decoded.parts[0])) : null;
        if (repo === null || decoded === null) {
          ctx.errors.push({ message: 'subject not found for addComment' });
          return null;
        }
        const number = Number(decoded.parts[1]);
        const comment = forge.addComment(repo, number, String(input.body ?? ''));
        const nodeObj: Obj = { __type: 'IssueComment', repo, issueNumber: number, comment };
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node: nodeObj } };
      }
      default:
        return unknown();
    }
  }
  if (source === null) return null;
  if (type === 'User') {
    switch (node.name) {
      case 'login':
        return VIEWER.login;
      case 'id':
        return globalId('User', VIEWER.id);
      case 'name':
        return VIEWER.name;
      case 'email':
        return VIEWER.email;
      default:
        return unknown();
    }
  }
  if (type === 'Repository') {
    const repo = source.repo as RepoRec;
    switch (node.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'owner':
        return userObj();
      case 'defaultBranchRef': {
        const target = forge.resolveCommit(repo, `refs/heads/${repo.defaultBranch}`);
        return { __type: 'Ref', name: repo.defaultBranch, oid: target };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'hasPullRequestsEnabled':
        return true;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueObj(repo, issue);
      }
      case 'issues': {
        let issues = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null && states.length > 0) {
          issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
        issues.sort((a, b) => (orderBy?.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        const page = paginate(issues.map((issue) => issueObj(repo, issue)), args);
        return connectionObj('IssueConnection', page);
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullObj(repo, pull);
      }
      case 'pullRequests': {
        const pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
        const page = paginate(pulls.map((pull) => pullObj(repo, pull)), args);
        return connectionObj('PullRequestConnection', page);
      }
      default:
        return unknown();
    }
  }
  if (type === 'Issue') {
    const repo = source.repo as RepoRec;
    const issue = source.issue as IssueRec;
    switch (node.name) {
      case 'id':
        return globalId('Issue', repo.id, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'author':
        return userObj();
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'repository':
        return repoObj(repo);
      default:
        return unknown();
    }
  }
  if (type === 'PullRequest') {
    const repo = source.repo as RepoRec;
    const pull = source.pull as PullRec;
    switch (node.name) {
      case 'id':
        return globalId('PullRequest', repo.id, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeCommit':
        return pull.mergeCommitSha === null ? null : { __type: 'Commit', oid: pull.mergeCommitSha };
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pull.merged ? 'UNKNOWN' : forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      case 'author':
        return userObj();
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'repository':
        return repoObj(repo);
      case 'files': {
        const files = forge.pullFiles(repo, pull).map((file): Obj => ({
          __type: 'PullRequestChangedFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        }));
        const page = paginate(files, args);
        return connectionObj('PullRequestChangedFileConnection', page);
      }
      default:
        return unknown();
    }
  }
  if (type === 'Ref') {
    if (node.name === 'name') return source.name;
    if (node.name === 'prefix') return 'refs/heads/';
    if (node.name === 'target') return source.oid === null || source.oid === undefined ? null : { __type: 'Commit', oid: source.oid };
    return unknown();
  }
  if (type === 'Commit') {
    if (node.name === 'oid') return source.oid;
    if (node.name === 'id') return globalId('Commit', String(source.oid));
    return unknown();
  }
  if (type === 'IssueComment') {
    const comment = source.comment as { id: number; body: string; createdAt: string };
    if (node.name === 'id') return globalId('IssueComment', (source.repo as RepoRec).id, source.issueNumber as number, comment.id);
    if (node.name === 'body') return comment.body;
    if (node.name === 'author') return userObj();
    if (node.name === 'createdAt') return comment.createdAt;
    return unknown();
  }
  if (type.endsWith('Payload')) {
    if (node.name === 'clientMutationId') return null;
    const value = source[node.name];
    return value === undefined ? unknown() : value;
  }
  if (type.endsWith('Connection')) {
    const page = source.page as Page<Obj>;
    switch (node.name) {
      case 'nodes':
        return page.items;
      case 'edges':
        return page.items.map((item, index) => ({ __type: 'Edge', node: item, cursor: cursorFor(index) }));
      case 'pageInfo':
        return { __type: 'PageInfo', page };
      case 'totalCount':
        return page.total;
      default:
        return unknown();
    }
  }
  if (type === 'PageInfo') {
    const page = source.page as Page<Obj>;
    switch (node.name) {
      case 'hasNextPage':
        return page.hasNextPage;
      case 'hasPreviousPage':
        return false;
      case 'startCursor':
        return page.startCursor;
      case 'endCursor':
        return page.endCursor;
      default:
        return unknown();
    }
  }
  if (type === 'IssueCommentEdge' || type === 'Edge') {
    if (node.name === 'node') return source.node;
    if (node.name === 'cursor') return source.cursor ?? null;
    return unknown();
  }
  if (type === '__Type') {
    const name = source.name as string;
    switch (node.name) {
      case 'name':
        return name;
      case 'kind':
        return TYPE_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT';
      case 'fields':
        return (TYPE_FIELDS[name] ?? []).map((fieldName): Obj => ({ __type: '__Field', name: fieldName }));
      case 'enumValues':
        return (TYPE_ENUMS[name] ?? []).map((valueName): Obj => ({ __type: '__EnumValue', name: valueName }));
      case 'description':
        return null;
      default:
        return unknown();
    }
  }
  if (type === '__Field' || type === '__EnumValue') {
    if (node.name === 'name') return source.name;
    if (node.name === 'description') return null;
    if (node.name === 'isDeprecated') return false;
    if (node.name === 'deprecationReason') return null;
    if (node.name === 'type') return { __type: '__Type', name: 'String' };
    if (node.name === 'args') return [];
    return unknown();
  }
  if (type === '__Schema') {
    if (node.name === 'types') return [...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_ENUMS)].map((name): Obj => ({ __type: '__Type', name }));
    if (node.name === 'queryType') return { __type: '__Type', name: 'Query' };
    if (node.name === 'mutationType') return { __type: '__Type', name: 'Mutation' };
    return unknown();
  }
  // Plain data wrappers (a changed file, an edge) answer their own properties.
  if (Object.prototype.hasOwnProperty.call(source, node.name)) return source[node.name];
  return unknown();
}

function completeValue(ctx: ExecCtx, value: unknown, node: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, node));
  if (typeof value === 'object' && (value as Obj).__type !== undefined && node.selectionSet !== null) {
    return executeSelectionSet(ctx, value as Obj, node.selectionSet);
  }
  return value;
}

function executeSelectionSet(ctx: ExecCtx, source: Obj, selections: readonly SelectionItem[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = source.__type;
  for (const item of selections) {
    if (item.kind === 'fragment') {
      if (item.typeCondition === type) Object.assign(out, executeSelectionSet(ctx, source, item.selectionSet));
      continue;
    }
    const key = item.alias ?? item.name;
    if (item.name === '__typename') {
      out[key] = type;
      continue;
    }
    const rawType = type === 'Query' || type === 'Mutation' ? type : type;
    const value = resolveField(ctx, rawType, source, item);
    out[key] = completeValue(ctx, value, item);
  }
  return out;
}

function executeOperation(forge: Forge, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: ExecCtx = { forge, variables, errors: [] };
  const root: Obj = { __type: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(ctx, root, operation.selectionSet);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** Route POST /api/graphql (single or batched operations); returns false outside the path. */
export async function handleGraphql(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/graphql') return false;
  if (!authorized(req)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  if (req.method !== 'POST') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results: Array<{ data: Record<string, unknown>; errors?: Array<{ message: string }> }> = [];
  for (const entry of requests) {
    const body = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof body.query !== 'string') {
      results.push({ data: {}, errors: [{ message: 'Missing query' }] });
      continue;
    }
    try {
      const operations = new Parser(body.query).parseDocument();
      const operation =
        operations.find((candidate) => candidate.name === body.operationName) ?? operations[0];
      if (operation === undefined) {
        results.push({ data: {}, errors: [{ message: 'No operation in document' }] });
        continue;
      }
      const variables = typeof body.variables === 'object' && body.variables !== null ? (body.variables as Record<string, unknown>) : {};
      results.push(executeOperation(forge, operation, variables));
    } catch (err) {
      results.push({ data: {}, errors: [{ message: err instanceof Error ? err.message : 'GraphQL error' }] });
    }
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
  return true;
}
