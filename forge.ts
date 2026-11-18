// The forge's state and domain operations: repositories (one git object store and ref table
// each), labels, issues, comments and pull requests over that store, the contents API's
// commit-on-write behaviour, and the three-way merge a pull request merge performs. Every
// surface (REST, GraphQL, MCP, git smart HTTP) works on this one store, so an object created
// through any of them is the same object through all the others.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  putObject,
  type GitObj,
  type ObjectStore,
  type TreeEntry,
} from './git.ts';

/** The one user the trial's token names: the suite's scenario viewer, fixed by its seed. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export class ForgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private entitySeq = 0;
  private orderSeq = 0;
  private lastSecond = 0;

  /** A strictly increasing second counter: commit timestamps never repeat or go backwards. */
  nowSecond(): number {
    const now = Math.floor(Date.now() / 1000);
    this.lastSecond = Math.max(now, this.lastSecond + 1);
    return this.lastSecond;
  }

  nowIso(): string {
    return new Date(this.nowSecond() * 1000).toISOString();
  }

  private identity(): string {
    return `${VIEWER.name} <${VIEWER.email}> ${this.nowSecond()} +0000`;
  }

  // ------------------------------------------------------------ repositories

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean }): RepoRec {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) throw new ForgeError(422, `Repository creation failed: ${name} already exists`);
    this.repoSeq += 1;
    const stamp = this.nowIso();
    const repo: RepoRec = {
      id: this.repoSeq,
      owner,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec {
    const repo = this.repos.get(`${owner}/${name}`);
    if (repo === undefined) throw new ForgeError(404, 'Not Found');
    return repo;
  }

  findRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): void {
    if (!this.repos.delete(`${owner}/${name}`)) throw new ForgeError(404, 'Not Found');
  }

  listRepos(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  // ------------------------------------------------------------ trees and files

  /** Flatten a tree (by id) into path -> {oid, mode}; directories appear as their files. */
  flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return out;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** The flat file map at a commit, or an empty map when the commit does not exist. */
  filesAtCommit(repo: RepoRec, commitOid: string): Map<string, { oid: string; mode: string }> {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(commit.data).tree);
  }

  /** Build nested trees from a flat file map and store them; returns the root tree id. */
  writeTree(repo: RepoRec, files: Map<string, { oid: string; mode: string }>): string {
    interface DirNode {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        let next = node.dirs.get(part);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1] as string, file);
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
      return putObject(repo.objects, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on a branch from a flat file map; returns the new commit id. */
  commitFiles(
    repo: RepoRec,
    branch: string,
    files: Map<string, { oid: string; mode: string }>,
    message: string,
    extraParents: readonly string[] = [],
  ): string {
    const tree = this.writeTree(repo, files);
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const parents = [...(parent !== undefined ? [parent] : []), ...extraParents];
    const identity = this.identity();
    const data = buildCommit({ tree, parents, author: identity, committer: identity, message });
    const oid = putObject(repo.objects, 'commit', data);
    repo.refs.set(ref, oid);
    repo.updatedAt = this.nowIso();
    return oid;
  }

  /** Resolve a ref-ish (branch name, full ref, HEAD, or object id) to a commit id. */
  resolveCommit(repo: RepoRec, ref: string): string | null {
    if (ref === 'HEAD') {
      const target = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return target ?? null;
    }
    const byRef = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    const oid = byRef ?? (repo.objects.has(ref) ? ref : null);
    if (oid === null) return null;
    const object = repo.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      // peel through the tag chain
      let current = oid;
      for (let hops = 0; hops < 16; hops += 1) {
        const tagObject = repo.objects.get(current);
        if (tagObject === undefined || tagObject.type !== 'tag') break;
        const text = tagObject.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})/m.exec(text);
        if (match === null) break;
        current = match[1] as string;
        const target = repo.objects.get(current);
        if (target !== undefined && target.type === 'commit') return current;
      }
    }
    return null;
  }

  /**
   * The contents API's write: create or update one file on a branch with a commit. A branch
   * that does not exist yet starts from the default branch's tip (or as a root commit on an
   * empty repository's default branch). A stale `sha` is a 409.
   */
  putFile(
    repo: RepoRec,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    sha: string | undefined,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const ref = `refs/heads/${branch}`;
    if (!repo.refs.has(ref)) {
      const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (base !== undefined) repo.refs.set(ref, base);
    }
    const tip = repo.refs.get(ref);
    const files = tip !== undefined ? this.filesAtCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const existing = files.get(path);
    if (existing !== undefined && sha !== undefined && sha !== existing.oid) {
      throw new ForgeError(409, 'Conflict: the sha does not match the current file');
    }
    const blobSha = putObject(repo.objects, 'blob', content);
    files.set(path, { oid: blobSha, mode: existing?.mode ?? '100644' });
    const commitSha = this.commitFiles(repo, branch, files, message);
    return { commitSha, blobSha, created: existing === undefined };
  }

  /** The contents API's delete: remove one file on a branch with a commit. */
  deleteFile(repo: RepoRec, branch: string, path: string, message: string, sha: string | undefined): { commitSha: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) throw new ForgeError(404, 'Not Found');
    const files = this.filesAtCommit(repo, tip);
    const existing = files.get(path);
    if (existing === undefined) throw new ForgeError(404, 'Not Found');
    if (sha !== undefined && sha !== existing.oid) throw new ForgeError(409, 'Conflict: the sha does not match the current file');
    files.delete(path);
    const commitSha = this.commitFiles(repo, branch, files, message);
    return { commitSha };
  }

  /** Read a file or a directory listing at a ref. */
  readPath(
    repo: RepoRec,
    ref: string,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> } | null {
    const commit = this.resolveCommit(repo, ref);
    if (commit === null) return null;
    const commitObject = repo.objects.get(commit);
    if (commitObject === undefined) return null;
    let treeOid = parseCommit(commitObject.data).tree;
    if (path === '') {
      return { kind: 'dir', entries: this.listTree(repo, treeOid, '') };
    }
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[index]);
      if (entry === undefined) return null;
      if (index === parts.length - 1) {
        if (entry.mode === '40000') return { kind: 'dir', entries: this.listTree(repo, entry.oid, path) };
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined) return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  private listTree(repo: RepoRec, treeOid: string, prefix: string): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return [];
    return parseTree(tree.data).map((entry) => ({
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      oid: entry.oid,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  /** Commits reachable from a start commit, newest first (by forge/wall timestamp, then walk order). */
  listCommits(repo: RepoRec, startOid: string): Array<{ sha: string; message: string; author: string; committer: string; parents: string[] }> {
    const seen = new Set<string>();
    const out: Array<{ sha: string; message: string; author: string; committer: string; parents: string[]; time: number }> = [];
    const stack = [startOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const timeMatch = / (\d+) [+-]\d{4}$/.exec(commit.committer);
      out.push({
        sha: oid,
        message: commit.message,
        author: commit.author,
        committer: commit.committer,
        parents: commit.parents,
        time: timeMatch === null ? 0 : Number(timeMatch[1]),
      });
      stack.push(...commit.parents);
    }
    out.sort((a, b) => b.time - a.time);
    return out;
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): IssueRec {
    const labels = input.labels ?? [];
    for (const label of labels) {
      if (!repo.labels.has(label)) throw new ForgeError(422, `Validation Failed: label "${label}" does not exist`);
    }
    this.entitySeq += 1;
    this.orderSeq += 1;
    const stamp = this.nowIso();
    const issue: IssueRec = {
      number: repo.nextNumber++,
      id: this.entitySeq,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
      seq: this.orderSeq,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: RepoRec, number: number): IssueRec {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw new ForgeError(404, 'Not Found');
    return issue;
  }

  listIssues(repo: RepoRec, state: string, direction: 'asc' | 'desc'): IssueRec[] {
    const all = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
    all.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    return all;
  }

  addComment(repo: RepoRec, issueNumber: number, body: string): CommentRec {
    const issue = this.getIssue(repo, issueNumber);
    this.entitySeq += 1;
    const comment: CommentRec = { id: this.entitySeq, body, createdAt: this.nowIso() };
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: RepoRec, input: { title: string; body?: string; head: string; base: string }): PullRec {
    const headCommit = this.resolveCommit(repo, `refs/heads/${input.head}`);
    if (headCommit === null) throw new ForgeError(422, `Validation Failed: head branch "${input.head}" does not exist`);
    const baseCommit = this.resolveCommit(repo, `refs/heads/${input.base}`);
    if (baseCommit === null) throw new ForgeError(422, `Validation Failed: base branch "${input.base}" does not exist`);
    this.entitySeq += 1;
    this.orderSeq += 1;
    const stamp = this.nowIso();
    const pull: PullRec = {
      number: repo.nextNumber++,
      id: this.entitySeq,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: stamp,
      updatedAt: stamp,
      seq: this.orderSeq,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPull(repo: RepoRec, number: number): PullRec {
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw new ForgeError(404, 'Not Found');
    return pull;
  }

  listPulls(repo: RepoRec, state: string): PullRec[] {
    const all = [...repo.pulls.values()].filter((pull) => {
      if (state === 'all') return true;
      if (state === 'open') return pull.state === 'open';
      return pull.state === 'closed';
    });
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }

  /** The merge base (best common ancestor) of two commits, or null. */
  mergeBase(repo: RepoRec, a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const stack = [a];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.add(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
    }
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (ancestorsOfA.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    return null;
  }

  /** The files a pull request changes: merge base tree against head tree. */
  pullFiles(repo: RepoRec, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headCommit = this.resolveCommit(repo, `refs/heads/${pull.headRef}`);
    const baseCommit = this.resolveCommit(repo, `refs/heads/${pull.baseRef}`);
    if (headCommit === null || baseCommit === null) return [];
    const base = this.mergeBase(repo, baseCommit, headCommit) ?? baseCommit;
    return diffFiles(repo, this.filesAtCommit(repo, base), this.filesAtCommit(repo, headCommit));
  }

  /** Whether a pull request merges cleanly onto the current base tip. */
  pullMergeable(repo: RepoRec, pull: PullRec): boolean {
    if (pull.state !== 'open') return false;
    try {
      this.planMerge(repo, pull);
      return true;
    } catch {
      return false;
    }
  }

  /** The three-way merged file map for a pull request, or a 405 ForgeError on conflict. */
  planMerge(repo: RepoRec, pull: PullRec): Map<string, { oid: string; mode: string }> {
    const headCommit = this.resolveCommit(repo, `refs/heads/${pull.headRef}`);
    const baseCommit = this.resolveCommit(repo, `refs/heads/${pull.baseRef}`);
    if (headCommit === null || baseCommit === null) throw new ForgeError(405, 'Pull Request is not mergeable');
    const origin = this.mergeBase(repo, baseCommit, headCommit);
    const baseFiles = origin === null ? new Map<string, { oid: string; mode: string }>() : this.filesAtCommit(repo, origin);
    const headFiles = this.filesAtCommit(repo, headCommit);
    const currentFiles = this.filesAtCommit(repo, baseCommit);
    const merged = new Map(currentFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
    for (const path of paths) {
      const inBase = baseFiles.get(path)?.oid;
      const inHead = headFiles.get(path)?.oid;
      const inCurrent = currentFiles.get(path)?.oid;
      if (inHead === inBase) continue; // the head did not touch it: keep the base branch's version
      if (inCurrent === inBase) {
        // only the head changed it: take the head's version (or its deletion)
        const headEntry = headFiles.get(path);
        if (headEntry === undefined) merged.delete(path);
        else merged.set(path, headEntry);
        continue;
      }
      if (inCurrent === inHead) continue; // both sides made the same change
      throw new ForgeError(405, 'Pull Request is not mergeable: merge conflict');
    }
    return merged;
  }

  /** Merge a pull request (squash: one parent; merge: two). Returns the merge commit id. */
  mergePull(repo: RepoRec, pull: PullRec, method: string): string {
    if (pull.merged) throw new ForgeError(405, 'Pull Request is not mergeable: already merged');
    const mergedFiles = this.planMerge(repo, pull);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (baseTip === undefined || headTip === undefined) throw new ForgeError(405, 'Pull Request is not mergeable');
    const tree = this.writeTree(repo, mergedFiles);
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const identity = this.identity();
    const message = method === 'merge' ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}` : `${pull.title} (#${pull.number})`;
    const data = buildCommit({ tree, parents, author: identity, committer: identity, message });
    const oid = putObject(repo.objects, 'commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = oid;
    pull.updatedAt = pull.mergedAt;
    repo.updatedAt = pull.mergedAt;
    return oid;
  }
}

/** Line-based change counts between two flat file maps (a file's diff, GitHub's shape). */
export function diffFiles(
  repo: RepoRec,
  before: Map<string, { oid: string; mode: string }>,
  after: Map<string, { oid: string; mode: string }>,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  const linesOf = (oid: string | undefined): number => {
    if (oid === undefined) return 0;
    const blob = repo.objects.get(oid);
    if (blob === undefined) return 0;
    const text = blob.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry?.oid === newEntry?.oid) continue;
    if (oldEntry === undefined && newEntry !== undefined) {
      const additions = linesOf(newEntry.oid);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (newEntry === undefined && oldEntry !== undefined) {
      const deletions = linesOf(oldEntry.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const additions = linesOf(newEntry?.oid);
      const deletions = linesOf(oldEntry?.oid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** An object's id recomputed (the forge never trusts a claimed id). */
export function objectId(type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  return hashObject(type, data);
}

export type { GitObj };
