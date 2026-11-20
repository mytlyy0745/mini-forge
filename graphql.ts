// GraphQL v4: a small executor for exactly the documents gh and github-mcp-server
// send (see the kit's checks-graphql.ts). Hand-rolled parser, no dependencies.
// Supports variables, inline enums/objects/lists, aliases, inline fragments,
// batched operation arrays, __type introspection, and the five mutations.

import {
  VIEWER,
  mergeBase as storeMergeBase,
  parseCommit as storeParseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface Selection {
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections?: Selection[];
  fragmentType?: string;
}

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipWs(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos])) this.pos += 1;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  private eat(text: string): boolean {
    this.skipWs();
    if (this.src.startsWith(text, this.pos)) {
      this.pos += text.length;
      return true;
    }
    return false;
  }

  private expect(text: string): void {
    if (!this.eat(text)) throw new Error(`expected ${JSON.stringify(text)} at ${this.pos}`);
  }

  private name(): string {
    this.skipWs();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!match) throw new Error(`expected name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private string(): string {
    this.skipWs();
    if (this.src[this.pos] !== '"') throw new Error(`expected string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length && this.src[this.pos] !== '"') {
      if (this.src[this.pos] === '\\') {
        this.pos += 1;
        const esc = this.src[this.pos];
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'u' ? String.fromCharCode(parseInt(this.src.slice(this.pos + 1, this.pos + 5), 16)) : esc;
        if (esc === 'u') this.pos += 4;
        this.pos += 1;
      } else {
        out += this.src[this.pos];
        this.pos += 1;
      }
    }
    this.pos += 1;
    return out;
  }

  private value(): ValueNode {
    this.skipWs();
    const ch = this.src[this.pos];
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.name() };
    }
    if (ch === '"') return { kind: 'string', value: this.string() };
    if (ch === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      while (!this.eat(']')) values.push(this.value());
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.eat('}')) {
        const name = this.name();
        this.expect(':');
        fields.push({ name, value: this.value() });
      }
      return { kind: 'object', fields };
    }
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (match) {
      this.pos += match[0].length;
      return match[0].includes('.') || /[eE]/.test(match[0])
        ? { kind: 'float', value: Number(match[0]) }
        : { kind: 'int', value: Number(match[0]) };
    }
    const word = this.name();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }

  private args(): Array<{ name: string; value: ValueNode }> {
    const out: Array<{ name: string; value: ValueNode }> = [];
    if (!this.eat('(')) return out;
    while (!this.eat(')')) {
      const name = this.name();
      this.expect(':');
      out.push({ name, value: this.value() });
    }
    return out;
  }

  private selectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (!this.eat('}')) {
      if (this.eat('...')) {
        if (this.eat('on')) {
          const type = this.name();
          const selections = this.selectionSet();
          out.push({ name: '__fragment', args: [], selections, fragmentType: type });
        } else {
          // Named fragment spread: not used by the suite's documents; skip its set.
          this.name();
          this.skipWs();
        }
        continue;
      }
      const first = this.name();
      let alias: string | undefined;
      let name = first;
      if (this.eat(':')) {
        alias = first;
        name = this.name();
      }
      const args = this.args();
      const selections = this.peek() === '{' ? this.selectionSet() : undefined;
      out.push({ alias, name, args, selections });
    }
    return out;
  }

  parseOperation(): Operation {
    this.skipWs();
    let kind: 'query' | 'mutation' = 'query';
    if (this.eat('query')) kind = 'query';
    else if (this.eat('mutation')) kind = 'mutation';
    let name: string | undefined;
    if (/[A-Za-z_]/.test(this.peek())) name = this.name();
    // Variable definitions: skip them (values come from the variables object).
    if (this.eat('(')) {
      let depth = 1;
      while (depth > 0 && this.pos < this.src.length) {
        const ch = this.src[this.pos++];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        else if (ch === '"') {
          while (this.pos < this.src.length && this.src[this.pos] !== '"') {
            if (this.src[this.pos] === '\\') this.pos += 1;
            this.pos += 1;
          }
          this.pos += 1;
        }
      }
    }
    const selections = this.selectionSet();
    return { kind, name, selections };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(selection: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of selection.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- schema introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'closedAt', 'mergedAt', 'mergeCommitSha'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt', 'isPrivate'],
  User: ['id', 'login', 'name', 'email'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
};

const SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC'];

// ---------------------------------------------------------------- executor

type JsonValue = unknown;

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

const gqlState = (issue: Issue): string => (issue.state === 'open' ? 'OPEN' : 'CLOSED');
const gqlPrState = (pull: Pull): string => (pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueJson(ctx: Ctx, issue: Issue): Record<string, unknown> {
  void ctx;
  return {
    __typename: 'Issue',
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: gqlState(issue),
    body: issue.body,
    url: '',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
  };
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: gqlPrState(pull),
    merged: pull.merged,
    mergeable: ctx.store.mergeableState(repo, pull),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergedAt: pull.mergedAt,
    mergeCommitSha: pull.mergeCommitSha,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
  };
}

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  void ctx;
  return {
    __typename: 'Repository',
    id: repo.globalId,
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function resolveSelections(ctx: Ctx, typeName: string, object: Record<string, unknown>, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.name === '__fragment') {
      if (selection.fragmentType === typeName || selection.fragmentType === undefined) {
        Object.assign(out, resolveSelections(ctx, typeName, object, selection.selections ?? []));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(ctx, typeName, object, selection);
  }
  return out;
}

function unknownField(ctx: Ctx, typeName: string, name: string): null {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

function resolveField(ctx: Ctx, typeName: string, object: Record<string, unknown>, selection: Selection): JsonValue {
  const name = selection.name;
  const args = argsOf(selection, ctx.variables);
  const subs = selection.selections ?? [];

  if (name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (name === 'viewer') {
      const viewer = { __typename: 'User', login: VIEWER.login, id: 'VXNlcjoxMDAw', name: VIEWER.name, email: VIEWER.email };
      return resolveSelections(ctx, 'User', viewer, subs);
    }
    if (name === 'repository') {
      const owner = args.owner as string;
      const repoName = args.name as string;
      const repo = owner === VIEWER.login ? ctx.store.getRepo(owner, repoName) : undefined;
      if (repo === undefined) return null;
      return resolveSelections(ctx, 'Repository', repoJson(ctx, repo), subs);
    }
    if (name === 'node') {
      const id = args.id as string;
      const found = ctx.store.findByGlobalId(id);
      if (found === null) return null;
      if (found.kind === 'Repository') return resolveSelections(ctx, 'Repository', repoJson(ctx, found.repo), subs);
      if (found.kind === 'Issue' && found.issue) return resolveSelections(ctx, 'Issue', issueJson(ctx, found.issue), subs);
      if (found.kind === 'PullRequest' && found.pull) return resolveSelections(ctx, 'PullRequest', pullJson(ctx, found.repo, found.pull), subs);
      return null;
    }
    if (name === '__type') {
      const typeNameArg = args.name as string;
      return resolveType(ctx, typeNameArg, subs);
    }
    return unknownField(ctx, 'Query', name);
  }

  if (typeName === 'Mutation') {
    return resolveMutation(ctx, selection, args);
  }

  if (typeName === '__Type') {
    return resolveTypeField(ctx, object, selection);
  }

  if (typeName === 'Repository') {
    const repo = (object as unknown as { __repo?: Repo }).__repo;
    // repoJson carries no back-reference; recover the repo from its id.
    const realRepo = repo ?? ctx.store.findByGlobalId(object.id as string)?.repo;
    if (realRepo === undefined) return unknownField(ctx, typeName, name);
    if (name === 'owner') {
      const owner = { __typename: 'User', login: realRepo.owner, id: 'VXNlcjoxMDAw', name: VIEWER.name, email: VIEWER.email };
      return resolveSelections(ctx, 'User', owner, subs);
    }
    if (name === 'defaultBranchRef') {
      const tip = realRepo.refs.get(`refs/heads/${realRepo.defaultBranch}`);
      if (tip === undefined) return null;
      return resolveSelections(ctx, 'Ref', { __typename: 'Ref', name: realRepo.defaultBranch, target: { oid: tip } }, subs);
    }
    if (name === 'issue') {
      const number = args.number as number;
      const issue = realRepo.issues.find((i) => i.number === number);
      if (issue === undefined) return null;
      return resolveSelections(ctx, 'Issue', issueJson(ctx, issue), subs);
    }
    if (name === 'issues') {
      return issuesConnection(ctx, realRepo, args, subs);
    }
    if (name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : 100;
      const pulls = [...realRepo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
      const nodes = pulls.map((p) => resolveSelections(ctx, 'PullRequest', pullJson(ctx, realRepo, p), subsOf(subs, 'nodes')));
      return { nodes, pageInfo: { hasNextPage: false, endCursor: null }, totalCount: realRepo.pulls.length };
    }
    if (name === 'pullRequest') {
      const number = args.number as number;
      const pull = realRepo.pulls.find((p) => p.number === number);
      if (pull === undefined) return null;
      return resolveSelections(ctx, 'PullRequest', pullJson(ctx, realRepo, pull), subs);
    }
    if (name === 'id' || name === 'databaseId' || name === 'name' || name === 'nameWithOwner' || name === 'viewerPermission' || name === 'hasIssuesEnabled' || name === 'description' || name === 'isPrivate' || name === 'createdAt' || name === 'updatedAt') {
      return object[name] ?? null;
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'Issue') {
    if (['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt'].includes(name)) return object[name] ?? null;
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'PullRequest') {
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 100;
      const found = ctx.store.findByGlobalId(object.id as string);
      const repo = found?.repo;
      const realPull = found?.pull;
      if (repo === undefined || realPull === undefined) return { nodes: [], totalCount: 0 };
      const nodes = prFilesImpl(ctx.store, repo, realPull).slice(0, first).map((path) => ({ path }));
      return { nodes, totalCount: nodes.length };
    }
    if (['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergedAt', 'mergeCommitSha', 'createdAt', 'updatedAt'].includes(name)) {
      return object[name] ?? null;
    }
    return unknownField(ctx, typeName, name);
  }

  if (typeName === 'User' || typeName === 'Ref') {
    if (name in object) {
      const value = object[name];
      if (subs.length > 0 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return resolveSelections(ctx, typeName, value as Record<string, unknown>, subs);
      }
      return value ?? null;
    }
    return unknownField(ctx, typeName, name);
  }

  return unknownField(ctx, typeName, name);
}

function subsOf(selections: Selection[], fieldName: string): Selection[] {
  const found = selections.find((s) => s.name === fieldName);
  return found?.selections ?? [];
}

function prFilesImpl(store: Store, repo: Repo, pull: Pull): string[] {
  const base = storeMergeBase(repo.objects.get.bind(repo.objects), pull.baseSha, pull.headSha);
  if (base === null) return [];
  const baseCommit = repo.objects.get(base);
  const headCommit = repo.objects.get(pull.headSha);
  if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit') return [];
  const baseTree = storeParseCommit(baseCommit.data).tree;
  const headTree = storeParseCommit(headCommit.data).tree;
  return store.diffFiles(repo, baseTree, headTree).map((d) => d.path);
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>, subs: Selection[]): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? args.after : null;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  let issues = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  if (orderBy.direction === 'DESC') issues.sort((a, b) => b.number - a.number || b.createdSeq - a.createdSeq);
  else if (orderBy.direction === 'ASC') issues.sort((a, b) => a.number - b.number || a.createdSeq - b.createdSeq);
  else issues.sort((a, b) => a.number - b.number);
  let start = 0;
  if (after !== null) {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const index = issues.findIndex((i) => i.number === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const page = issues.slice(start, start + first);
  const nodes = page.map((issue) => resolveSelections(ctx, 'Issue', issueJson(ctx, issue), subsOf(subs, 'nodes')));
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  const out: Record<string, unknown> = { nodes, totalCount: issues.length };
  const pageInfoSel = subs.find((s) => s.name === 'pageInfo');
  if (pageInfoSel !== undefined) out.pageInfo = { hasNextPage, endCursor };
  else out.pageInfo = { hasNextPage, endCursor };
  return out;
}

function resolveType(ctx: Ctx, name: string, subs: Selection[]): Record<string, unknown> {
  const object: Record<string, unknown> = { __typename: '__Type', name, kind: name === 'SearchType' ? 'ENUM' : 'OBJECT' };
  return resolveSelections(ctx, '__Type', object, subs);
}

function resolveTypeField(ctx: Ctx, object: Record<string, unknown>, selection: Selection): JsonValue {
  const name = selection.name;
  const typeName = object.name as string;
  if (name === 'name' || name === 'kind') return object[name] ?? null;
  if (name === 'fields') {
    const fields = TYPE_FIELDS[typeName] ?? [];
    return fields.map((field) => ({ name: field }));
  }
  if (name === 'enumValues') {
    if (typeName === 'SearchType') return SEARCH_ENUMS.map((value) => ({ name: value }));
    return [];
  }
  return unknownField(ctx, '__Type', name);
}

function resolveMutation(ctx: Ctx, selection: Selection, args: Record<string, unknown>): JsonValue {
  const name = selection.name;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const subs = selection.selections ?? [];
  const wrap = (key: string, inner: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const sub of subs) {
      if (sub.name === key) out[key] = resolveSelections(ctx, key === 'issue' ? 'Issue' : key === 'pullRequest' ? 'PullRequest' : 'IssueComment', inner, sub.selections ?? []);
      else if (sub.name === 'commentEdge') {
        const nodeSel = sub.selections?.find((s) => s.name === 'node');
        out.commentEdge = { node: nodeSel ? resolveSelections(ctx, 'IssueComment', inner, nodeSel.selections ?? []) : inner };
      }
    }
    return out;
  };

  if (name === 'createIssue') {
    const found = ctx.store.findByGlobalId(input.repositoryId as string);
    if (found === null || found.kind !== 'Repository') {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const issue = ctx.store.createIssue(found.repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return wrap('issue', issueJson(ctx, issue));
  }
  if (name === 'closeIssue') {
    const found = ctx.store.findByGlobalId(input.issueId as string);
    if (found === null || found.kind !== 'Issue' || !found.issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.closedAt = ctx.store.nowIso();
    found.issue.updatedAt = found.issue.closedAt;
    return wrap('issue', issueJson(ctx, found.issue));
  }
  if (name === 'createPullRequest') {
    const found = ctx.store.findByGlobalId(input.repositoryId as string);
    if (found === null || found.kind !== 'Repository') {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const repo = found.repo;
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) {
      ctx.errors.push({ message: `Head or base ref not found: ${headRef} / ${baseRef}.` });
      return null;
    }
    const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headSha, baseSha);
    return wrap('pullRequest', pullJson(ctx, repo, pull));
  }
  if (name === 'mergePullRequest') {
    const found = ctx.store.findByGlobalId(input.pullRequestId as string);
    if (found === null || found.kind !== 'PullRequest' || !found.pull) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
      return null;
    }
    const mergedSha = ctx.store.squashMerge(found.repo, found.pull);
    if (mergedSha === null) {
      ctx.errors.push({ message: 'Pull request cannot be merged (conflict).' });
      return null;
    }
    return wrap('pullRequest', pullJson(ctx, found.repo, found.pull));
  }
  if (name === 'addComment') {
    const found = ctx.store.findByGlobalId(input.subjectId as string);
    if (found === null || found.kind !== 'Issue' || !found.issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    const repo = found.repo;
    const issue = found.issue;
    repo.commentSeq += 1;
    const commentId = repo.commentSeq;
    const now = ctx.store.nowIso();
    const comment = {
      id: commentId,
      globalId: Buffer.from(`IssueComment:${repo.dbId}:${issue.number}:${commentId}`, 'utf8').toString('base64'),
      body: String(input.body ?? ''),
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    const node = { __typename: 'IssueComment', id: comment.globalId, body: comment.body, createdAt: now, updatedAt: now };
    const out: Record<string, unknown> = {};
    for (const sub of subs) {
      if (sub.name === 'commentEdge') {
        const nodeSel = sub.selections?.find((s) => s.name === 'node');
        out.commentEdge = { node: nodeSel ? resolveSelections(ctx, 'IssueComment', node, nodeSel.selections ?? []) : node };
      }
    }
    return out;
  }
  return unknownField(ctx, 'Mutation', name);
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function executeOne(store: Store, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { store, variables, errors: [] };
  let operation: Operation;
  try {
    operation = new Parser(query).parseOperation();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelections(ctx, rootType, {}, operation.selections);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'Invalid operation' }] };
      const { query, variables } = entry as { query?: unknown; variables?: unknown };
      if (typeof query !== 'string') return { data: null, errors: [{ message: 'Must provide query string.' }] };
      return executeOne(store, query, (variables ?? {}) as Record<string, unknown>);
    });
    return { status: 200, body: results };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 400, body: { errors: [{ message: 'Must provide query string.' }] } };
  }
  const { query, variables } = body as { query?: unknown; variables?: unknown };
  if (typeof query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'Must provide query string.' }] } };
  }
  return { status: 200, body: executeOne(store, query, (variables ?? {}) as Record<string, unknown>) };
}
