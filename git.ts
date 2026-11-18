// The git object model, implemented from the protocol's own rules on node:crypto and node:zlib:
// content-addressed objects (commit, tree, blob, tag) hashed with SHA-1 over "<type> <size>\0",
// packfiles version 2 (read with ofs/ref delta resolution, written as full objects), and the
// pkt-line framing every smart-HTTP exchange uses. No git binary anywhere: this file is the
// whole object layer the forge's git, REST contents and merge code build on.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  readonly type: ObjType;
  readonly data: Buffer;
}

export type ObjectStore = Map<string, GitObj>;

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODES: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** An object's id: SHA-1 of its header and bytes, the one rule every surface agrees on. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object and return its id; storing the same bytes twice is a no-op. */
export function putObject(store: ObjectStore, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// --------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes: "<mode> <name>\0<20-byte id>" repeated. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('ascii', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries in git's order (directories sort as if their name ended in "/"). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit: header lines, a blank line, then the message, byte for byte. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const view: TagView = { object: '', type: '', tag: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
  }
  return view;
}

/** Peel an object id to the commit it ultimately names (through annotated tags), or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// --------------------------------------------------------------------- reachability

/** Every object reachable from the given tips (commits, their trees and blobs, tags peeled). */
export function reachableObjects(store: ObjectStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` by walking commit parents. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

export interface FetchSelection {
  /** The objects to pack, in a stable order (commits first, then trees, blobs, tags). */
  objects: GitObj[];
  /** Commit ids at the new depth boundary: held after this fetch, with a parent that is not. */
  boundary: string[];
  /** The client's old boundary commits that this fetch un-shallows. */
  unshallow: string[];
}

/**
 * Choose what a fetch sends. What the client already holds is the closure of its `haves`,
 * cut at its `shallow` boundary (a shallow commit is held; its parents are not). A fetch
 * with a depth sends the commits within that many generations of the wants that the client
 * does not hold, with their trees and blobs; without a depth it sends the wants' whole
 * closure minus the held objects. The boundary names the included commits whose parent
 * stayed behind — the shallow-info lines of the reply.
 */
export function selectFetchObjects(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
): FetchSelection {
  const shallowSet = new Set(shallow);
  // What the client holds: from the haves, not crossing a shallow boundary.
  const heldCommits = new Set<string>();
  const heldStack = [...haves];
  while (heldStack.length > 0) {
    const oid = heldStack.pop() as string;
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      heldStack.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit' || heldCommits.has(oid)) continue;
    heldCommits.add(oid);
    if (shallowSet.has(oid)) continue;
    heldStack.push(...parseCommit(object.data).parents);
  }
  const held = new Set<string>();
  const holdClosure = (oid: string): void => {
    if (held.has(oid)) return;
    const object = store.get(oid);
    if (object === undefined) return;
    if (object.type === 'commit' && !heldCommits.has(oid)) return;
    held.add(oid);
    if (object.type === 'commit') holdClosure(parseCommit(object.data).tree);
    else if (object.type === 'tree') for (const entry of parseTree(object.data)) holdClosure(entry.oid);
    else if (object.type === 'tag') holdClosure(parseTag(object.data).object);
  };
  for (const commit of heldCommits) holdClosure(commit);
  for (const have of haves) {
    const object = store.get(have);
    if (object !== undefined && object.type === 'tag') holdClosure(have);
  }

  const send = new Set<string>();
  const addObject = (oid: string): void => {
    if (send.has(oid) || held.has(oid)) return;
    const object = store.get(oid);
    if (object === undefined) return;
    send.add(oid);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) addObject(entry.oid);
  };

  let boundary: string[] = [];
  let unshallow: string[] = [];
  if (depth === null) {
    for (const oid of reachableObjects(store, wants)) {
      if (!held.has(oid)) send.add(oid);
    }
  } else {
    // Commit generations from the wants: a want commit is generation 1.
    const generations = new Map<string, number>();
    const queue: string[] = [];
    const enqueue = (oid: string, gen: number): void => {
      const commit = peelToCommit(store, oid);
      if (commit === null) return;
      const known = generations.get(commit);
      if (known === undefined || gen < known) {
        generations.set(commit, gen);
        queue.push(commit);
      }
    };
    for (const want of wants) enqueue(want, 1);
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      const gen = generations.get(oid) as number;
      if (gen >= depth) continue;
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) enqueue(parent, gen + 1);
    }
    const limited = new Set<string>();
    for (const [commit, gen] of generations) if (gen <= depth) limited.add(commit);
    for (const want of wants) {
      const object = store.get(want);
      if (object !== undefined && object.type === 'tag' && !held.has(want)) send.add(want);
    }
    for (const commit of limited) {
      if (heldCommits.has(commit)) continue;
      send.add(commit);
      const object = store.get(commit);
      if (object !== undefined && object.type === 'commit') addObject(parseCommit(object.data).tree);
    }
    boundary = [...limited].filter((commit) => {
      const object = store.get(commit);
      if (object === undefined || object.type !== 'commit') return false;
      return parseCommit(object.data).parents.some((parent) => !limited.has(parent) && store.has(parent));
    });
    unshallow = [...shallowSet].filter((oid) => limited.has(oid) && !boundary.includes(oid));
  }
  const rank: Record<ObjType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const objects = [...send]
    .map((oid) => store.get(oid) as GitObj)
    .sort((a, b) => rank[a.type] - rank[b.type]);
  return { objects, boundary, unshallow };
}

// --------------------------------------------------------------------- deltas

function readDeltaSize(delta: Buffer, state: { offset: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = delta[state.offset] as number;
    state.offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return value;
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const state = { offset: 0 };
  const sourceSize = readDeltaSize(delta, state);
  const targetSize = readDeltaSize(delta, state);
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (state.offset < delta.length) {
    const op = delta[state.offset] as number;
    state.offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[state.offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[state.offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, state.offset, state.offset + literal);
      state.offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// --------------------------------------------------------------------- packfiles

function packEntryHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a packfile version 2 of full objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackEntry {
  offset: number;
  kind: 'full' | 'ofs' | 'ref';
  type?: ObjType;
  data?: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile into `store`, resolving ofs-delta and ref-delta entries against bases in
 * the pack itself or already in the store (a thin pack). Returns the object ids it stored.
 */
export function readPackInto(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry & { oid?: string }>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let entry: PackEntry;
    if (code === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      entry = { offset: start, kind: 'ofs', baseOffset: start - value };
    } else if (code === 7) {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      entry = { offset: start, kind: 'ref', baseOid };
    } else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`pack entry type code ${code}`);
      entry = { offset: start, kind: 'full', type };
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    entry.data = inflated.buffer;
    if (entry.data.length !== size) throw new Error('pack entry size mismatch');
    offset += inflated.engine.bytesWritten;
    entries.push(entry);
    byOffset.set(start, entry);
  }
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolve = (entry: PackEntry & { oid?: string }): { type: ObjType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let out: { type: ObjType; data: Buffer; oid: string };
    if (entry.kind === 'full') {
      const type = entry.type as ObjType;
      const data = entry.data as Buffer;
      out = { type, data, oid: hashObject(type, data) };
    } else {
      let base: { type: ObjType; data: Buffer; oid: string } | undefined;
      if (entry.kind === 'ofs') {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
        base = resolve(baseEntry);
      } else {
        const baseOid = entry.baseOid as string;
        const inPack = entries.find((candidate) => candidate.oid === baseOid);
        if (inPack !== undefined) base = resolve(inPack);
        else {
          const stored = store.get(baseOid);
          if (stored === undefined) throw new Error('ref-delta base missing');
          base = { type: stored.type, data: stored.data, oid: baseOid };
        }
      }
      const data = applyDelta(base.data, entry.data as Buffer);
      out = { type: base.type, data, oid: hashObject(base.type, data) };
    }
    entry.oid = out.oid;
    resolved.set(entry.offset, out);
    return out;
  };
  const stored: string[] = [];
  for (const entry of entries) {
    const object = resolve(entry);
    if (!store.has(object.oid)) store.set(object.oid, { type: object.type, data: object.data });
    stored.push(object.oid);
  }
  return stored;
}

// --------------------------------------------------------------------- pkt-lines

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** One pkt-line: a 4-hex-digit length (counting itself) and the payload. */
export function encodePkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Split a buffer into pkt-lines; returns the packets and the bytes after the first flush. */
export function parsePkts(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const hex = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** The text lines of a packet list (data packets only, trailing newline kept off). */
export function pktTextLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Chunk a pack into sideband band-1 pkt-lines (payload at most 65516 bytes each). */
export function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    out.push(encodePkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (out.length === 0) out.push(encodePkt(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return out;
}
