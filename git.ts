// git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack and
// v0 receive-pack, spoken over pkt-lines with side-band-64k framing. No git binary:
// packs are built and read here, on node:zlib and node:crypto (see store.ts).

import {
  collectDepthLimited,
  collectHaves,
  collectReachable,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  putObject,
  readPackSync,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktEnd = (): Buffer => Buffer.from('0002', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse a whole body into packets; throws on malformed framing. */
export function decodePackets(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

function packetLines(packets: Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/** Split side-band-64k packets: returns {pack, progress} from band-1/band-2 payloads. */
export function sidebandWrap(data: Buffer, chunkSize = 32768): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) {
    // No band-1 data at all: the packfile section still needs a packet for the
    // empty pack, so callers pass the (non-empty) empty pack instead.
  }
  return out;
}

// ---------------------------------------------------------------- refs

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function peelOid(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object?.type === 'tag') return parseTag(object.data).object;
  return undefined;
}

/** HEAD's line for ls-refs / advertisements: the default branch tip, or unborn. */
function headRef(repo: Repo): RefLine {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return { oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true };
  return { oid: tip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` };
}

function allRefLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [headRef(repo)];
  for (const { name, oid } of sortedRefs(repo)) {
    const peeled = name.startsWith('refs/tags/') ? peelOid(repo, oid) : undefined;
    lines.push(peeled !== undefined ? { oid, name, peeled } : { oid, name });
  }
  return lines;
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'mini-forge/1.0';

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktFlush(),
  ]);
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const { name, oid } of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      if (name.startsWith('refs/tags/')) {
        const peeled = peelOid(repo, oid);
        if (peeled !== undefined) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function infoRefs(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo, wantsV2: boolean): { status: number; contentType: string; body: Buffer } {
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(service, repo),
  };
}

// ---------------------------------------------------------------- upload-pack v2

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

function parseV2Args(packets: Pkt[]): { command: string; args: string[] } {
  const lines = packetLines(packets);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
      // agent= / object-format= lines are accepted and ignored.
      continue;
    }
    args.push(line.trim());
  }
  void lines;
  return { command, args };
}

function fetchResponse(repo: Repo, fetchArgs: FetchArgs, done: boolean): Buffer {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const { included, boundary } = collectDepthLimited(fetchArgs.wants, lookup, fetchArgs.depth ?? Number.POSITIVE_INFINITY);
  const haveSet = collectHaves(fetchArgs.haves, lookup, new Set(fetchArgs.shallowBoundaries));
  const toSend: GitObject[] = [];
  for (const oid of included) {
    if (haveSet.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) toSend.push(object);
  }
  const pack = writePack(toSend);
  const parts: Buffer[] = [];
  // Acknowledgments, as real git speaks them (verified against git 2.43):
  //  - no haves at all: no acknowledgments section; the packfile follows.
  //  - haves with a common object: 'ACK <oid>' per common have, then a bare
  //    'ready' line, then the delim — and the packfile follows in this
  //    response, whether or not the client sent 'done'.
  //  - haves with nothing in common: 'NAK'. Without 'done' the response
  //    ends here (flush, no delim); the client re-requests with 'done' and
  //    gets the packfile then. With 'done' the packfile follows at once.
  if (fetchArgs.haves.length > 0) {
    const commonHaves = fetchArgs.haves.filter((have) => repo.objects.has(have));
    parts.push(pktLine('acknowledgments\n'));
    if (commonHaves.length === 0) {
      parts.push(pktLine('NAK\n'));
      if (!done) {
        parts.push(pktFlush());
        return Buffer.concat(parts);
      }
    } else {
      for (const have of commonHaves) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(pktDelim());
  }
  // shallow-info
  const newBoundary = [...boundary].sort();
  const oldBoundary = fetchArgs.shallowBoundaries.filter((oid) => included.has(oid) && !boundary.has(oid));
  if (fetchArgs.depth !== null || fetchArgs.shallowBoundaries.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of newBoundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of oldBoundary) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandWrap(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    // 'unborn' and anything else: accepted, no extra work.
  }
  const lines = allRefLines(repo).filter((ref) => prefixes.length === 0 || prefixes.some((p) => ref.name.startsWith(p)));
  const parts: Buffer[] = [];
  for (const ref of lines) {
    if (ref.unborn === true) {
      parts.push(pktLine(`unborn ${ref.name}${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPackV2(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  let packets: Pkt[];
  try {
    packets = decodePackets(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line stream') };
  }
  const { command, args } = parseV2Args(packets);
  if (command === 'ls-refs') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
  }
  if (command === 'fetch') {
    const fetchArgs: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], depth: null };
    let done = false;
    for (const arg of args) {
      if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) fetchArgs.shallowBoundaries.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) {
        const n = Number.parseInt(arg.slice(7).trim(), 10);
        if (Number.isFinite(n)) fetchArgs.depth = n;
      } else if (arg === 'done') done = true;
      // wait-for-done, thin-pack, no-progress, ofs-delta, filter: accepted, no action needed.
    }
    // A multi-round client may send the follow-up 'done' request without
    // repeating the wants; reuse the wants from the previous round for this repo.
    if (fetchArgs.wants.length > 0) lastFetchWants.set(repo, fetchArgs.wants);
    else {
      const prev = lastFetchWants.get(repo);
      if (prev !== undefined) fetchArgs.wants = [...prev];
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, fetchArgs, done) };
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown v2 command ${command}`) };
}

// Remembers the wants of the last fetch per repo, for multi-round clients
// whose follow-up 'done' request omits them (stateless HTTP keeps no state).
const lastFetchWants = new WeakMap<Repo, string[]>();

// ---------------------------------------------------------------- upload-pack v0

export function handleUploadPackV0(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  let packets: Pkt[];
  try {
    packets = decodePackets(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line stream') };
  }
  const lines = packetLines(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let done = false;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line === 'done') done = true;
    // capability tokens: no action.
  }
  void lines;
  void section;
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const { included, boundary } = collectDepthLimited(wants, lookup, depth ?? Number.POSITIVE_INFINITY);
  const haveSet = collectHaves(haves, lookup, new Set(shallowBoundaries));
  const toSend: GitObject[] = [];
  for (const oid of included) {
    if (haveSet.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) toSend.push(object);
  }
  const pack = writePack(toSend);
  const parts: Buffer[] = [];
  // Multi-round negotiation (see the v2 handler): without 'done', answer the
  // acknowledgments only and send no packfile yet.
  if (haves.length === 0) parts.push(pktLine('NAK\n'));
  else {
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  }
  if (haves.length > 0 && !done) {
    parts.push(pktFlush());
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  if (depth !== null || shallowBoundaries.length > 0) {
    for (const oid of [...boundary].sort()) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of shallowBoundaries) {
      if (included.has(oid) && !boundary.has(oid)) parts.push(pktLine(`unshallow ${oid}\n`));
    }
  }
  for (const packet of sidebandWrap(pack)) parts.push(packet);
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- receive-pack v0

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  // Commands are pkt-lines up to the first flush; the pack follows raw.
  let offset = 0;
  const commands: PushCommand[] = [];
  let packStart = body.length;
  let malformed = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) {
      malformed = true;
      break;
    }
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      offset += 4;
      packStart = offset;
      break;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > body.length) {
      malformed = true;
      break;
    }
    const line = body.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    const nul = line.indexOf('\0');
    const clean = (nul >= 0 ? line.slice(0, nul) : line).trim();
    const parts = clean.split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  if (!malformed && packBytes.length > 0) {
    try {
      const { objects } = readPackSync(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  } else if (malformed) {
    unpackOk = false;
    unpackDetail = 'malformed command stream';
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    if (!unpackOk) {
      reportLines.push(`ng ${ref} unpack failed`);
      continue;
    }
    if (!/^refs\/(heads|tags)\//.test(ref)) {
      reportLines.push(`ng ${ref} invalid ref`);
      continue;
    }
    const current = repo.refs.get(ref);
    if (newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reportLines.push(`ng ${ref} ref does not exist`);
      else if (oldOid !== ZERO_OID && oldOid !== current) reportLines.push(`ng ${ref} non-fast-forward`);
      else {
        repo.refs.delete(ref);
        reportLines.push(`ok ${ref}`);
      }
      continue;
    }
    if (!repo.objects.has(newOid)) {
      reportLines.push(`ng ${ref} object not found`);
      continue;
    }
    if (oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${ref} already exists`);
        continue;
      }
      repo.refs.set(ref, newOid);
      reportLines.push(`ok ${ref}`);
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${ref} ref does not exist`);
      continue;
    }
    if (current !== oldOid) {
      reportLines.push(`ng ${ref} non-fast-forward`);
      continue;
    }
    if (!isAncestor(lookup, oldOid, newOid)) {
      reportLines.push(`ng ${ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(ref, newOid);
    reportLines.push(`ok ${ref}`);
  }
  const reportStream = Buffer.concat([
    pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`),
    ...reportLines.map((line) => pktLine(`${line}\n`)),
    pktFlush(),
  ]);
  const sideband = sidebandWrap(reportStream, 32768);
  const bodyOut = Buffer.concat([...sideband, pktFlush()]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}

// ---------------------------------------------------------------- helpers exported for tests

export { collectReachable, hashObject, parseCommit, parseTree, putObject };
