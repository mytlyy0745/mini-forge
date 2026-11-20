// mini-forge store: the in-memory forge state plus the pure git object model.
// One process, no disk, no git binary: objects live in Maps, refs in Maps.
// Determinism: every timestamp comes from a fixed base epoch plus a counter, never
// from the wall clock, so two runs over the same requests leave identical state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function putObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees / commits / tags

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
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
  timestamp: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  lines.push(fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  timestamp: number;
  message: string;
}): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} +0000\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- reachability

export type Lookup = (oid: string) => GitObject | undefined;

/** Every object reachable from the tips (commits, their trees/blobs, tag targets). */
export function collectReachable(tips: Iterable<string>, lookup: Lookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/**
 * Reachability with a depth limit: commits at depth 1..maxDepth from a tip are included
 * (a tag's target counts at the tag's depth). The boundary is the set of commits sitting
 * exactly at maxDepth — their parents are not followed, and they are the shallow boundary.
 * Non-commit objects of included commits are always included in full.
 */
export function collectDepthLimited(
  tips: Iterable<string>,
  lookup: Lookup,
  maxDepth: number,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  if (!Number.isFinite(maxDepth)) return { included: collectReachable(tips, lookup), boundary };
  // BFS over commits with depths; tags resolve at the same depth as the tag.
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 1 });
  const includeObject = (oid: string): void => {
    if (included.has(oid)) return;
    const object = lookup(oid);
    if (object === undefined) return;
    included.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) includeObject(entry.oid);
    } else if (object.type === 'tag') {
      // A tag's target is followed at the tag's own depth by the caller.
    }
  };
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    const known = commitDepth.get(oid);
    if (known !== undefined && known <= depth) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      includeObject(oid);
      queue.push({ oid: target, depth });
      continue;
    }
    if (object.type !== 'commit') {
      includeObject(oid);
      continue;
    }
    commitDepth.set(oid, depth);
    includeObject(oid);
    const view = parseCommit(object.data);
    includeObject(view.tree);
    if (depth >= maxDepth) {
      boundary.add(oid);
      continue;
    }
    for (const parent of view.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return { included, boundary };
}

/**
 * Reachability from haves, stopping descent at `stopAt` commits: a stop commit itself
 * (plus its tree/blobs) is included, its parents are not. Models a shallow client's
 * already-held objects below its shallow boundary.
 */
export function collectHaves(haves: Iterable<string>, lookup: Lookup, stopAt: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      if (!stopAt.has(oid)) for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (including tip === ancestor). */
export function isAncestor(lookup: Lookup, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    } else if (object?.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return false;
}

/** A merge base of a and b: BFS from b until hitting an ancestor of a (linear histories: exact). */
export function mergeBase(lookup: Lookup, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const qa = [a];
  while (qa.length > 0) {
    const oid = qa.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) qa.push(p);
    else if (object?.type === 'tag') qa.push(parseTag(object.data).object);
  }
  const seen = new Set<string>();
  const qb = [b];
  while (qb.length > 0) {
    const oid = qb.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) qb.push(p);
    else if (object?.type === 'tag') qb.push(parseTag(object.data).object);
  }
  return null;
}

// ---------------------------------------------------------------- packfiles (plain objects only; deltas resolved on read)

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) copyOffset |= delta[offset++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) copySize |= delta[offset++] << (8 * i);
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Synchronous pack reader built on zlib's streaming inflate, tracking consumed input
 * bytes exactly.
 */
export function readPackSync(pack: Buffer, externalLookup?: Lookup): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const deltas: Array<{ offset: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string }> = [];
  let deltaCount = 0;
  let offset = 12;
  const inflateAt = (start: number): { data: Buffer; next: number } => {
    // Binary-search the smallest prefix that inflates cleanly; the zlib stream ends
    // exactly there. Prefixes are tried on a doubling ladder, which is fast for the
    // small objects this forge handles (and correct for any size).
    let lo = start + 1;
    let hi = -1;
    let probe = Math.min(pack.length - 20, start + 32);
    while (probe <= pack.length - 20) {
      try {
        inflateSync(pack.subarray(start, probe));
        hi = probe;
        break;
      } catch {
        if (probe === pack.length - 20) break;
        probe = Math.min(pack.length - 20, probe * 2);
      }
    }
    if (hi === -1) throw new Error('zlib stream does not terminate in pack');
    // Shrink to the minimal end.
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      try {
        inflateSync(pack.subarray(start, mid));
        hi = mid;
      } catch {
        lo = mid + 1;
      }
    }
    return { data: inflateSync(pack.subarray(start, lo)), next: lo };
  };
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const type = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      let b = pack[offset++];
      let base = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - base;
    } else if (type === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, next } = inflateAt(offset);
    offset = next;
    if (data.length !== size) throw new Error(`pack entry size mismatch: header ${size}, inflated ${data.length}`);
    if (type === 6 || type === 7) {
      deltaCount += 1;
      deltas.push({ offset: entryOffset, type, data, baseOffset, baseOid });
    } else {
      const objType = CODE_TYPE[type];
      if (objType === undefined) throw new Error(`unknown pack object type ${type}`);
      const oid = hashObject(objType, data);
      objects.set(oid, { type: objType, data });
      byOffset.set(entryOffset, { type: objType, data, oid });
    }
  }
  // Resolve deltas (bases may appear later in the pack for REF_DELTA, and a
  // thin push pack may delta against objects the server already holds, which
  // the caller supplies through externalLookup). Resolution runs as a
  // worklist: a delta whose base is not available yet is retried after other
  // deltas resolve; if the list stalls, the base is genuinely missing.
  class Unresolved extends Error {}
  const resolveDelta = (entry: { type: number; data: Buffer; baseOffset?: number; baseOid?: string }, guard: Set<number>): { type: GitObjectType; data: Buffer } => {
    let base: { type: GitObjectType; data: Buffer } | undefined;
    if (entry.type === 6) {
      const found = byOffset.get(entry.baseOffset!);
      if (found !== undefined) base = found;
      else {
        const nested = deltas.find((d) => d.offset === entry.baseOffset);
        if (nested === undefined) throw new Error('ofs-delta base not in pack');
        if (guard.has(nested.offset)) throw new Error('delta cycle');
        guard.add(nested.offset);
        base = resolveDelta(nested, guard);
      }
    } else {
      const found = objects.get(entry.baseOid!);
      if (found !== undefined) base = found;
      else if (externalLookup !== undefined) {
        const ext = externalLookup(entry.baseOid!);
        if (ext !== undefined) base = ext;
      }
      if (base === undefined) throw new Unresolved('ref-delta base not yet available');
    }
    const data = applyDelta(base.data, entry.data);
    return { type: base.type, data };
  };
  const pending = [...deltas];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      try {
        const resolved = resolveDelta(pending[i], new Set([pending[i].offset]));
        const oid = hashObject(resolved.type, resolved.data);
        objects.set(oid, resolved);
        byOffset.set(pending[i].offset, { type: resolved.type, data: resolved.data, oid });
        pending.splice(i, 1);
        progress = true;
      } catch (err) {
        if (err instanceof Unresolved) continue;
        throw err;
      }
    }
  }
  if (pending.length > 0) throw new Error('ref-delta base not in pack');
  return { objects, deltaCount };
}

/** Write a PACK v2 of plain objects (no deltas), sorted by oid for stability. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  list.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const code = TYPE_CODE[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (code << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- the store

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  dbId: number;
  globalId: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  commentSeq: number;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

const gid = (kind: string, ...parts: Array<string | number>): string =>
  Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private seq = 0;
  private commitCounter = 0;
  readonly baseEpoch: number;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = trialNow !== '' ? Date.parse(trialNow) : Number.NaN;
    this.baseEpoch = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1760000000;
  }

  /** Deterministic ISO timestamp: base epoch plus one second per call. */
  nowIso(): string {
    this.seq += 1;
    return new Date((this.baseEpoch + this.seq) * 1000).toISOString();
  }

  /** Deterministic commit timestamp (seconds). */
  commitTs(): number {
    this.commitCounter += 1;
    return this.baseEpoch + this.commitCounter;
  }

  identity(): string {
    return `${VIEWER.name} <${VIEWER.email}>`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const dbId = this.nextRepoId++;
    const now = this.nowIso();
    const repo: Repo = {
      dbId,
      globalId: gid('Repository', dbId),
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      commentSeq: 0,
      seq: this.seq,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listUserRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.seq - b.seq);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  // -- git object helpers -------------------------------------------------

  /** Resolve a ref name, branch name or oid to a commit oid (or undefined). */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : undefined;
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) {
      const object = repo.objects.get(tag);
      if (object?.type === 'tag') return parseTag(object.data).object;
      return tag;
    }
    return undefined;
  }

  /** Entries of a tree object. */
  treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** Walk a tree path; returns the oid of the entry at `path` (or undefined). */
  lookupPath(repo: Repo, commitOid: string, path: string): { oid: string; type: GitObjectType } | undefined {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    const segments = path.split('/').filter((s) => s !== '');
    let treeOid = parseCommit(commit.data).tree;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = this.treeEntries(repo, treeOid);
      const entry = entries.find((e) => e.name === segments[i]);
      if (entry === undefined) return undefined;
      if (i === segments.length - 1) {
        const object = repo.objects.get(entry.oid);
        return object === undefined ? undefined : { oid: entry.oid, type: object.type };
      }
      if (entry.mode !== '40000') return undefined;
      treeOid = entry.oid;
    }
    return undefined;
  }

  /** Immediate children of a directory path in a commit's tree. */
  listDir(repo: Repo, commitOid: string, dirPath: string): TreeEntry[] | null {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    const segments = dirPath.split('/').filter((s) => s !== '');
    for (const segment of segments) {
      const entries = this.treeEntries(repo, treeOid);
      const entry = entries.find((e) => e.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return this.treeEntries(repo, treeOid);
  }

  /**
   * Set (or delete, when blobOid is null) a file at `path` in the tree rooted at
   * `rootTreeOid` (null for an empty tree). Returns the new root tree oid.
   */
  setPath(repo: Repo, rootTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (treeOid: string | null, depth: number): string | null => {
      const entries = treeOid === null ? [] : this.treeEntries(repo, treeOid);
      const name = segments[depth];
      if (depth === segments.length - 1) {
        const next = entries.filter((e) => e.name !== name);
        if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
        if (next.length === 0) return null;
        return putObject(repo.objects, 'tree', buildTree(next));
      }
      const existing = entries.find((e) => e.name === name);
      const child = build(existing?.mode === '40000' ? existing.oid : null, depth + 1);
      const next = entries.filter((e) => e.name !== name);
      if (child !== null) next.push({ mode: '40000', name, oid: child });
      if (next.length === 0) return null;
      return putObject(repo.objects, 'tree', buildTree(next));
    };
    const result = build(rootTreeOid, 0);
    if (result === null) return putObject(repo.objects, 'tree', buildTree([]));
    return result;
  }

  /** Commits reachable from a tip, newest-first (DFS, parents after the commit). */
  listCommits(repo: Repo, tipOid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tipOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    return out;
  }

  /** Create a commit object on this repo. */
  makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree,
      parents,
      author: this.identity(),
      committer: this.identity(),
      timestamp: this.commitTs(),
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    return putObject(repo.objects, 'commit', data);
  }

  // -- diff / merge --------------------------------------------------------

  /** Flat file map of a tree: path -> blob oid (recursive). */
  flatTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of this.treeEntries(repo, treeOid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [k, v] of this.flatTree(repo, entry.oid, path)) out.set(k, v);
      } else {
        out.set(path, entry.oid);
      }
    }
    return out;
  }

  diffFiles(repo: Repo, baseTree: string, headTree: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid?: string; newOid?: string }> {
    const base = this.flatTree(repo, baseTree);
    const head = this.flatTree(repo, headTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid?: string; newOid?: string }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) out.push({ path, status: 'added', newOid: h });
      else if (b !== undefined && h === undefined) out.push({ path, status: 'removed', oldOid: b });
      else if (b !== undefined && h !== undefined && b !== h) out.push({ path, status: 'modified', oldOid: b, newOid: h });
    }
    return out;
  }

  /** Line counts for a file change: additions/deletions by multiset line diff. */
  lineCounts(repo: Repo, oldOid: string | undefined, newOid: string | undefined): { additions: number; deletions: number } {
    const linesOf = (oid: string | undefined): Map<string, number> => {
      const map = new Map<string, number>();
      if (oid === undefined) return map;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'blob') return map;
      const text = object.data.toString('utf8');
      const lines = text === '' ? [] : text.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
      return map;
    };
    const oldLines = linesOf(oldOid);
    const newLines = linesOf(newOid);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newLines) additions += Math.max(0, count - (oldLines.get(line) ?? 0));
    for (const [line, count] of oldLines) deletions += Math.max(0, count - (newLines.get(line) ?? 0));
    return { additions, deletions };
  }

  /** Is merging `pr` conflicted? A path changed on both sides of the merge base with different results. */
  prConflicts(repo: Repo, pr: Pull): boolean {
    const base = mergeBase(repo.objects.get.bind(repo.objects), pr.baseSha, pr.headSha);
    if (base === null) return pr.baseSha !== pr.headSha;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(pr.headSha);
    const baseTipCommit = repo.objects.get(pr.baseSha);
    if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit' || baseTipCommit?.type !== 'commit') return true;
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const tipTree = parseCommit(baseTipCommit.data).tree;
    const headChanges = new Map(this.diffFiles(repo, baseTree, headTree).map((d) => [d.path, d]));
    const tipChanges = new Map(this.diffFiles(repo, baseTree, tipTree).map((d) => [d.path, d]));
    for (const [path, headChange] of headChanges) {
      const tipChange = tipChanges.get(path);
      if (tipChange === undefined) continue;
      if (headChange.newOid !== tipChange.newOid) return true;
      if (headChange.status !== tipChange.status) return true;
    }
    return false;
  }

  mergeableState(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pr.state !== 'open') return 'UNKNOWN';
    return this.prConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge an open pull request onto its base branch. Returns the merge commit oid,
   * or null when the pull is conflicted.
   */
  squashMerge(repo: Repo, pr: Pull): string | null {
    if (pr.state !== 'open') return null;
    if (this.prConflicts(repo, pr)) return null;
    const base = mergeBase(repo.objects.get.bind(repo.objects), pr.baseSha, pr.headSha);
    const baseCommit = repo.objects.get(pr.baseSha);
    const headCommit = repo.objects.get(pr.headSha);
    if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit') return null;
    let tree = parseCommit(baseCommit.data).tree;
    if (base !== null) {
      const baseBase = repo.objects.get(base);
      if (baseBase?.type === 'commit') {
        const baseTree = parseCommit(baseBase.data).tree;
        const headTree = parseCommit(headCommit.data).tree;
        for (const change of this.diffFiles(repo, baseTree, headTree)) {
          tree = this.setPath(repo, tree, change.path, change.status === 'removed' ? null : change.newOid ?? null);
        }
      }
    } else {
      tree = parseCommit(headCommit.data).tree;
    }
    const message = `Squash merge pull request #${pr.number}: ${pr.title}`;
    const mergeSha = this.makeCommit(repo, tree, [pr.baseSha], message);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.nowIso();
    pr.mergeCommitSha = mergeSha;
    pr.closedAt = pr.mergedAt;
    pr.updatedAt = pr.mergedAt;
    return mergeSha;
  }

  // -- issues / pulls ------------------------------------------------------

  nextIssueId(repo: Repo): string {
    return gid('Issue', repo.dbId, repo.nextNumber);
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const now = this.nowIso();
    const issue: Issue = {
      number,
      globalId: gid('Issue', repo.dbId, number),
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.seq,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextNumber++;
    const now = this.nowIso();
    const pull: Pull = {
      number,
      globalId: gid('PullRequest', repo.dbId, number),
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdSeq: this.seq,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findByGlobalId(globalId: string): { kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment'; repo: Repo; issue?: Issue; pull?: Pull; comment?: Comment } | null {
    let decoded = '';
    try {
      decoded = Buffer.from(globalId, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const parts = decoded.split(':');
    const kind = parts[0];
    if (kind === 'Repository' && parts.length === 2) {
      const dbId = Number(parts[1]);
      for (const repo of this.repos.values()) if (repo.dbId === dbId) return { kind, repo };
      return null;
    }
    if ((kind === 'Issue' || kind === 'PullRequest') && parts.length === 3) {
      const dbId = Number(parts[1]);
      const number = Number(parts[2]);
      for (const repo of this.repos.values()) {
        if (repo.dbId !== dbId) continue;
        if (kind === 'Issue') {
          const issue = repo.issues.find((i) => i.number === number);
          if (issue) return { kind, repo, issue };
        } else {
          const pull = repo.pulls.find((p) => p.number === number);
          if (pull) return { kind, repo, pull };
        }
      }
      return null;
    }
    if (kind === 'IssueComment' && parts.length === 4) {
      const dbId = Number(parts[1]);
      const number = Number(parts[2]);
      const commentId = Number(parts[3]);
      for (const repo of this.repos.values()) {
        if (repo.dbId !== dbId) continue;
        const issue = repo.issues.find((i) => i.number === number);
        const comment = issue?.comments.find((c) => c.id === commentId);
        if (issue && comment) return { kind, repo, issue, comment };
      }
      return null;
    }
    return null;
  }
}
