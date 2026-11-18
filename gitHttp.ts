// Git smart HTTP: the ref advertisements (protocol v2 capabilities for upload-pack, v0 for
// receive-pack), ls-refs, fetch (v2 sections and the v0 form) and receive-pack with
// report-status. The wire shapes are the ones a real git client speaks: pkt-lines, sideband
// band 1 for pack data, per-ref ok/ng answers, and non-fast-forward refused by that name.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  encodePkt,
  isAncestor,
  isOid,
  parsePkts,
  pktTextLines,
  readPackInto,
  selectFetchObjects,
  sidebandPackets,
  writePack,
  parseTag,
  type Pkt,
} from './git.ts';
import { ForgeError, type Forge, type RepoRec } from './forge.ts';
import { authorized, readBody, sendError } from './http.ts';

const AGENT = 'ghforge/1.0';

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  });
  res.end(body);
}

/** A repo's refs as [name, oid] pairs in advertisement order (heads, then tags, sorted). */
function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Peel a ref's target to a commit id for the ^{} line, or null when it is a commit already. */
function peeledOf(repo: RepoRec, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  let current = parseTag(object.data).object;
  for (let hops = 0; hops < 16; hops += 1) {
    const target = repo.objects.get(current);
    if (target === undefined) return null;
    if (target.type === 'commit') return current;
    if (target.type !== 'tag') return null;
    current = parseTag(target.data).object;
  }
  return null;
}

function v0Advertisement(repo: RepoRec, service: string): Buffer {
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headTip !== undefined) lines.push(`${headTip} HEAD`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}`);
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) lines.push(`${peeled} ${name}^{}`);
    }
  }
  lines.forEach((line, index) => {
    parts.push(encodePkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(service: string): Buffer {
  const parts: Buffer[] = [
    encodePkt(`# service=${service}\n`),
    PKT_FLUSH,
    encodePkt('version 2\n'),
    encodePkt(`agent=${AGENT}\n`),
    encodePkt('ls-refs=unborn\n'),
    encodePkt('fetch=shallow\n'),
    encodePkt('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

function handleLsRefs(repo: RepoRec, packets: readonly Pkt[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (!pastDelim || packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (keep('HEAD')) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const parts = lines.map((line) => encodePkt(`${line}\n`));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepenNot: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice('deepen-not '.length).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim()) || null;
  }
  return args;
}

function handleFetch(repo: RepoRec, packets: readonly Pkt[], rest: Buffer, version2: boolean, res: ServerResponse): void {
  let lines = pktTextLines(packets);
  if (!version2 && rest.length > 0) {
    // The v0 form carries its negotiation in a second pkt-line section after the flush.
    const second = parsePkts(rest);
    lines = [...lines, ...pktTextLines(second.packets)];
  }
  const args = parseFetchArgs(lines);
  const haves = [...args.haves, ...args.deepenNot];
  const selection = selectFetchObjects(repo.objects, args.wants, haves, args.shallow, args.depth);
  const pack = writePack(selection.objects);
  const commonHave = args.haves.find((have) => repo.objects.has(have));
  const parts: Buffer[] = [];
  if (version2) {
    parts.push(encodePkt('acknowledgments\n'));
    parts.push(encodePkt(commonHave !== undefined ? `ACK ${commonHave}\n` : 'NAK\n'));
    parts.push(PKT_DELIM);
    if (args.depth !== null || args.shallow.length > 0) {
      parts.push(encodePkt('shallow-info\n'));
      for (const oid of selection.boundary) parts.push(encodePkt(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(encodePkt('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  } else {
    for (const oid of selection.boundary) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(encodePkt(commonHave !== undefined ? `ACK ${commonHave} common\n` : 'NAK\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  }
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleReceivePack(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const { packets, rest } = parsePkts(body);
  const lines = pktTextLines(packets);
  if (lines.length === 0) throw new ForgeError(400, 'Bad request: no ref commands');
  let capabilities = '';
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  lines.forEach((raw, index) => {
    let line = raw;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  });
  if (commands.length === 0) throw new ForgeError(400, 'Bad request: no ref commands');
  let unpackLine = 'unpack ok';
  if (rest.length > 0) {
    try {
      readPackInto(repo.objects, rest);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}`;
    }
  }
  const sideband = capabilities.split(' ').includes('side-band-64k');
  const reportLines: string[] = [unpackLine];
  for (const command of commands) {
    reportLines.push(applyRefUpdate(repo, command, unpackLine === 'unpack ok'));
  }
  const reportParts = reportLines.map((line) => encodePkt(`${line}\n`));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  let bodyOut: Buffer;
  if (sideband) {
    const chunks: Buffer[] = [];
    const CHUNK = 65500;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const slice = report.subarray(offset, Math.min(offset + CHUNK, report.length));
      chunks.push(encodePkt(Buffer.concat([Buffer.from([1]), slice])));
    }
    chunks.push(PKT_FLUSH);
    bodyOut = Buffer.concat(chunks);
  } else {
    bodyOut = report;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', bodyOut);
}

/** Validate and apply one ref update; returns its report-status line. */
function applyRefUpdate(repo: RepoRec, command: { oldOid: string; newOid: string; ref: string }, unpackOk: boolean): string {
  const { oldOid, newOid, ref } = command;
  if (!unpackOk) return `ng ${ref} unpack failed`;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // a delete
    if (current === ZERO_OID) return `ng ${ref} reference does not exist`;
    if (current !== oldOid) return `ng ${ref} reference is not up to date`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const object = repo.objects.get(newOid);
  if (object === undefined) return `ng ${ref} missing object`;
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') return `ng ${ref} bad object type`;
  if (current === ZERO_OID) {
    if (oldOid !== ZERO_OID) return `ng ${ref} reference is not up to date`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return `ng ${ref} reference is not up to date`;
  if (current !== newOid && object.type === 'commit' && repo.objects.get(current)?.type === 'commit') {
    // an update: a branch must move fast-forward, refused by that exact name
    if (!isAncestor(repo.objects, current, newOid)) return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

/** Route one smart-HTTP request; returns false when the path is not a git path. */
export async function handleGitHttp(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const tail = match[3] ?? '';
  if (!authorized(req)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  const repo = forge.findRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  try {
    if (req.method === 'GET' && tail === '/info/refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendError(res, 400, 'Bad request: unknown service');
        return true;
      }
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const body = service === 'git-upload-pack' && wantsV2 ? v2Advertisement(service) : v0Advertisement(repo, service);
      sendBuffer(res, 200, `application/x-${service}-advertisement`, body);
      return true;
    }
    if (req.method === 'POST' && tail === '/git-upload-pack') {
      const body = await readBody(req);
      const { packets, rest } = parsePkts(body);
      const lines = pktTextLines(packets);
      if (lines.length === 0) throw new ForgeError(400, 'Bad request: no pkt-lines');
      const version2 = lines.some((line) => line.startsWith('command='));
      const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length);
      if (version2 && command === 'ls-refs') handleLsRefs(repo, packets, res);
      else handleFetch(repo, packets, rest, version2, res);
      return true;
    }
    if (req.method === 'POST' && tail === '/git-receive-pack') {
      const body = await readBody(req);
      handleReceivePack(repo, body, res);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  } catch (err) {
    if (err instanceof ForgeError) {
      sendError(res, err.status, err.message);
      return true;
    }
    throw err;
  }
}
