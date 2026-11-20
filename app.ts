// mini-forge HTTP server: REST v3 under /api/v3, GraphQL at /api/graphql, MCP at
// /mcp, git smart HTTP at /{owner}/{repo}.git, /healthz. One in-memory store,
// no disk, no outside services. Every REST reply is JSON with X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleReceivePack,
  handleUploadPackV0,
  handleUploadPackV2,
  infoRefs,
} from './git.ts';
import {
  Store,
  VIEWER,
  mergeBase,
  parseCommit,
  putObject,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(body === null ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(body);
}

function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

function err(message: string): { message: string } {
  return { message };
}

// ---------------------------------------------------------------- shapes

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: '',
    url: '',
    git_url: '',
    ssh_url: '',
    clone_url: '',
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
  };
}

function labelShape(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: '' };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.globalId,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelShape(repo, name)),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: '',
    url: '',
  };
}

function pullShape(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.globalId,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner } },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    draft: false,
    html_url: '',
    url: '',
  };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; hasNext: boolean; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length, pageNum, perPage };
}

function linkHeader(req: IncomingMessage, query: URLSearchParams, pageNum: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const host = req.headers.host ?? 'localhost';
  const path = new URL(req.url ?? '/', `http://${host}`).pathname;
  const next = new URLSearchParams(query);
  next.set('page', String(pageNum + 1));
  next.set('per_page', String(perPage));
  return `<http://${host}${path}?${next.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------- contents helpers

function commitIdentityLine(commitData: Buffer): { name: string; email: string; date: string } {
  const view = parseCommit(commitData);
  const match = /^(.*) <(.*)> (\d+) ([+-]\d+)$/.exec(view.author);
  if (match === null) return { name: VIEWER.name, email: VIEWER.email, date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

/** Commit one file change on a branch; creates the branch from the default tip when missing. */
function commitFile(
  store: Store,
  repo: Repo,
  branch: string | undefined,
  path: string,
  content: Buffer,
  message: string,
  expectedSha: string | undefined,
): { status: number; commitSha?: string; contentSha?: string; created?: boolean; message?: string } {
  let branchName = branch ?? repo.defaultBranch;
  let tip = store.branchTip(repo, branchName);
  if (tip === undefined && branch !== undefined && branch !== repo.defaultBranch) {
    // New branch: fork from the default branch tip (or start unborn).
    const base = store.branchTip(repo, repo.defaultBranch);
    if (base !== undefined) {
      repo.refs.set(`refs/heads/${branchName}`, base);
      tip = base;
    }
  }
  let parentTree: string | null = null;
  let parentCommit: string | null = null;
  if (tip !== undefined) {
    const commit = repo.objects.get(tip);
    if (commit?.type === 'commit') {
      parentCommit = tip;
      parentTree = parseCommit(commit.data).tree;
    }
  }
  const existing = parentCommit === null ? undefined : store.lookupPath(repo, parentCommit, path);
  if (expectedSha !== undefined) {
    if (existing === undefined || existing.oid !== expectedSha) {
      return { status: 409, message: 'sha does not match the current blob' };
    }
  }
  const blobSha = putObject(repo.objects, 'blob', content);
  const created = existing === undefined;
  const tree = store.setPath(repo, parentTree, path, blobSha);
  const parents = parentCommit === null ? [] : [parentCommit];
  const commitSha = store.makeCommit(repo, tree, parents, message);
  repo.refs.set(`refs/heads/${branchName}`, commitSha);
  return { status: created ? 201 : 200, commitSha, contentSha: blobSha, created };
}

// ---------------------------------------------------------------- the app

export function createApp(store: Store = new Store()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(req, res, store);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, err(e instanceof Error ? e.message : 'internal error'));
      }
    })();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const query = url.searchParams;

  // -- health probe (no auth) ------------------------------------------------
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // -- git smart HTTP --------------------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3] ?? '';
    const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      sendRaw(res, 404, 'text/plain', Buffer.from('Not Found'));
      return;
    }
    if (method === 'GET' && suffix === '/info/refs') {
      const service = query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendRaw(res, 400, 'text/plain', Buffer.from('unknown service'));
        return;
      }
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const out = infoRefs(service, repo, wantsV2);
      sendRaw(res, out.status, out.contentType, out.body);
      return;
    }
    if (method === 'POST' && suffix === '/git-upload-pack') {
      const body = await readBody(req);
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const out = wantsV2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      sendRaw(res, out.status, out.contentType, out.body);
      return;
    }
    if (method === 'POST' && suffix === '/git-receive-pack') {
      const body = await readBody(req);
      const out = handleReceivePack(repo, body);
      sendRaw(res, out.status, out.contentType, out.body);
      return;
    }
    sendRaw(res, 404, 'text/plain', Buffer.from('Not Found'));
    return;
  }

  // -- GraphQL ----------------------------------------------------------------
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, err('Not Found'));
      return;
    }
    if (!isAuthed(req)) {
      sendJson(res, 401, err('Requires authentication'));
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
      return;
    }
    const out = handleGraphQL(store, parsed.value);
    sendJson(res, out.status, out.body);
    return;
  }

  // -- MCP --------------------------------------------------------------------
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 404, err('Not Found'));
      return;
    }
    if (!isAuthed(req)) {
      sendJson(res, 401, err('Requires authentication'));
      return;
    }
    const raw = await readBody(req);
    const out = handleMcp(store, raw.toString('utf8'));
    if (out.body === null) {
      res.writeHead(out.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, out.status, out.body);
    return;
  }

  // -- REST v3 ----------------------------------------------------------------
  if (path === '/api/v3' || path === '/api/v3/') {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    sendJson(res, 404, err('Not Found'));
    return;
  }
  if (path === '/api/v3/meta') {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
      return;
    }
    sendJson(res, 404, err('Not Found'));
    return;
  }

  if (path.startsWith('/api/v3/')) {
    if (!isAuthed(req)) {
      sendJson(res, 401, err('Requires authentication'));
      return;
    }
    await handleRest(req, res, store, method, path.slice('/api/v3/'.length), query);
    return;
  }

  sendJson(res, 404, err('Not Found'));
}

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  method: string,
  restPath: string,
  query: URLSearchParams,
): Promise<void> {
  const segments = restPath.split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) {
    sendJson(res, 400, err('Invalid JSON body'));
    return;
  }
  const body = (parsed.value ?? {}) as Record<string, unknown>;
  const bodyObj = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};

  // -- /user ------------------------------------------------------------------
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email });
      return;
    }
    sendJson(res, 404, err('Not Found'));
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof bodyObj.name === 'string' ? bodyObj.name : '';
      if (name === '') {
        sendJson(res, 422, err('Repository name is required'));
        return;
      }
      if (store.getRepo(VIEWER.login, name) !== undefined) {
        sendJson(res, 422, err(`Repository ${VIEWER.login}/${name} already exists`));
        return;
      }
      const repo = store.createRepo(VIEWER.login, name, {
        description: typeof bodyObj.description === 'string' ? bodyObj.description : '',
        private: bodyObj.private === true,
        defaultBranch: typeof bodyObj.default_branch === 'string' ? bodyObj.default_branch : undefined,
      });
      sendJson(res, 201, repoShape(repo));
      return;
    }
    if (method === 'GET') {
      const repos = store.listUserRepos(VIEWER.login);
      const { page, hasNext, pageNum, perPage } = paginate(repos, query);
      const extra: Record<string, string> = {};
      const link = linkHeader(req, query, pageNum, perPage, hasNext);
      if (link !== null) extra.link = link;
      sendJson(res, 200, page.map(repoShape), extra);
      return;
    }
    sendJson(res, 404, err('Not Found'));
    return;
  }

  // -- /repos/{owner}/{repo}/... ----------------------------------------------
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const repoName = segments[2];
    const rest = segments.slice(3);
    const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;

    // Repository object itself.
    if (rest.length === 0) {
      if (method === 'GET') {
        if (repo === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        sendJson(res, 200, repoShape(repo));
        return;
      }
      if (method === 'PATCH') {
        if (repo === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        if (typeof bodyObj.description === 'string') repo.description = bodyObj.description;
        if (typeof bodyObj.private === 'boolean') repo.private = bodyObj.private;
        if (typeof bodyObj.default_branch === 'string' && repo.refs.has(`refs/heads/${bodyObj.default_branch}`)) {
          repo.defaultBranch = bodyObj.default_branch;
        }
        repo.updatedAt = store.nowIso();
        sendJson(res, 200, repoShape(repo));
        return;
      }
      if (method === 'DELETE') {
        if (repo === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        store.deleteRepo(owner, repoName);
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      sendJson(res, 404, err('Not Found'));
      return;
    }

    if (repo === undefined) {
      sendJson(res, 404, err('Not Found'));
      return;
    }

    // -- branches --------------------------------------------------------------
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([name]) => name.startsWith('refs/heads/'))
          .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
        branches.sort((a, b) => (a.name === repo.defaultBranch ? -1 : b.name === repo.defaultBranch ? 1 : a.name < b.name ? -1 : 1));
        sendJson(res, 200, branches);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const tip = store.branchTip(repo, rest[1]);
        if (tip === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        sendJson(res, 200, { name: rest[1], commit: { sha: tip }, protected: false });
        return;
      }
      sendJson(res, 404, err('Not Found'));
      return;
    }

    // -- git refs --------------------------------------------------------------
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof bodyObj.ref === 'string' ? bodyObj.ref : '';
        const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
        if (!/^refs\/(heads|tags)\//.test(ref) || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, err('Invalid ref or sha'));
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, err('Reference already exists'));
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit', url: '' } });
        return;
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).join('/');
        const tip = store.branchTip(repo, branch);
        if (tip === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit', url: '' } });
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const refs = [...repo.refs.entries()].map(([name, oid]) => ({ ref: name, object: { sha: oid, type: 'commit', url: '' } }));
        sendJson(res, 200, refs);
        return;
      }
      sendJson(res, 404, err('Not Found'));
      return;
    }

    // -- commits ---------------------------------------------------------------
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return;
      }
      const commits = store.listCommits(repo, tip).map((oid) => {
        const object = repo.objects.get(oid)!;
        const view = parseCommit(object.data);
        const author = commitIdentityLine(object.data);
        return {
          sha: oid,
          commit: {
            message: view.message.replace(/\n+$/, ''),
            author: { name: author.name, email: author.email, date: author.date },
            committer: { name: author.name, email: author.email, date: author.date },
          },
          author: { login: VIEWER.login },
          committer: { login: VIEWER.login },
        };
      });
      const { page } = paginate(commits, query);
      sendJson(res, 200, page);
      return;
    }

    // -- contents --------------------------------------------------------------
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'PUT') {
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'update';
        const contentB64 = typeof bodyObj.content === 'string' ? bodyObj.content : '';
        const branch = typeof bodyObj.branch === 'string' ? bodyObj.branch : undefined;
        const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : undefined;
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendJson(res, 422, err('Invalid base64 content'));
          return;
        }
        const result = commitFile(store, repo, branch, filePath, content, message, sha);
        if (result.status === 409) {
          sendJson(res, 409, err(result.message ?? 'Conflict'));
          return;
        }
        sendJson(res, result.status, {
          content: {
            name: filePath.split('/').pop() ?? '',
            path: filePath,
            sha: result.contentSha,
            size: content.length,
            type: 'file',
            encoding: 'base64',
            content: contentB64,
          },
          commit: { sha: result.commitSha, message },
        });
        return;
      }
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const tip = ref === undefined ? store.branchTip(repo, repo.defaultBranch) : store.resolveRef(repo, ref);
        if (tip === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        if (filePath === '') {
          const entries = store.listDir(repo, tip, '');
          if (entries === null) {
            sendJson(res, 404, err('Not Found'));
            return;
          }
          sendJson(res, 200, dirEntries(repo, tip, '', entries));
          return;
        }
        const found = store.lookupPath(repo, tip, filePath);
        if (found === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        if (found.type === 'tree') {
          const entries = store.listDir(repo, tip, filePath);
          if (entries === null) {
            sendJson(res, 404, err('Not Found'));
            return;
          }
          sendJson(res, 200, dirEntries(repo, tip, filePath, entries));
          return;
        }
        const blob = repo.objects.get(found.oid)!;
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: filePath.split('/').pop() ?? '',
          path: filePath,
          content: blob.data.toString('base64'),
          sha: found.oid,
        });
        return;
      }
      if (method === 'DELETE') {
        const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : undefined;
        const branch = typeof bodyObj.branch === 'string' ? bodyObj.branch : undefined;
        const branchName = branch ?? repo.defaultBranch;
        const tip = store.branchTip(repo, branchName);
        if (tip === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        const existing = store.lookupPath(repo, tip, filePath);
        if (existing === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        if (sha !== undefined && sha !== existing.oid) {
          sendJson(res, 409, err('sha does not match the current blob'));
          return;
        }
        const commit = repo.objects.get(tip)!;
        const tree = parseCommit(commit.data).tree;
        const newTree = store.setPath(repo, tree, filePath, null);
        const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'delete';
        const commitSha = store.makeCommit(repo, newTree, [tip], message);
        repo.refs.set(`refs/heads/${branchName}`, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return;
      }
      sendJson(res, 404, err('Not Found'));
      return;
    }

    // -- labels ----------------------------------------------------------------
    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
      const name = typeof bodyObj.name === 'string' ? bodyObj.name : '';
      const color = typeof bodyObj.color === 'string' ? bodyObj.color : 'ededed';
      if (name === '') {
        sendJson(res, 422, err('Label name is required'));
        return;
      }
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color, description: '' });
      return;
    }
    if (rest[0] === 'labels' && rest.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
      return;
    }

    // -- issues ----------------------------------------------------------------
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
          if (title === '') {
            sendJson(res, 422, err('Title is required'));
            return;
          }
          const labels = Array.isArray(bodyObj.labels) ? (bodyObj.labels as unknown[]).map(String) : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendJson(res, 422, err(`Label does not exist: ${label}`));
              return;
            }
          }
          const issue = store.createIssue(repo, title, typeof bodyObj.body === 'string' ? bodyObj.body : '', labels);
          sendJson(res, 201, issueShape(repo, issue));
          return;
        }
        if (method === 'GET') {
          let issues = [...repo.issues];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') issues = issues.filter((i) => i.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const { page } = paginate(issues, query);
          sendJson(res, 200, page.map((i) => issueShape(repo, i)));
          return;
        }
        sendJson(res, 404, err('Not Found'));
        return;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) {
        sendJson(res, 404, err('Not Found'));
        return;
      }
      const issue = repo.issues.find((i) => i.number === number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (issue === undefined) {
            sendJson(res, 404, err('Not Found'));
            return;
          }
          sendJson(res, 200, issueShape(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (issue === undefined) {
            sendJson(res, 404, err('Not Found'));
            return;
          }
          if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
          if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
          if (typeof bodyObj.state === 'string' && (bodyObj.state === 'open' || bodyObj.state === 'closed')) {
            issue.state = bodyObj.state;
            issue.closedAt = bodyObj.state === 'closed' ? store.nowIso() : null;
          }
          if (Array.isArray(bodyObj.labels)) {
            const labels = (bodyObj.labels as unknown[]).map(String);
            for (const label of labels) {
              if (!repo.labels.has(label)) {
                sendJson(res, 422, err(`Label does not exist: ${label}`));
                return;
              }
            }
            issue.labels = labels;
          }
          issue.updatedAt = store.nowIso();
          sendJson(res, 200, issueShape(repo, issue));
          return;
        }
        sendJson(res, 404, err('Not Found'));
        return;
      }
      if (rest[2] === 'comments') {
        if (issue === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        if (method === 'POST') {
          const commentBody = typeof bodyObj.body === 'string' ? bodyObj.body : '';
          repo.commentSeq += 1;
          const commentId = repo.commentSeq;
          const now = store.nowIso();
          const comment = {
            id: commentId,
            globalId: Buffer.from(`IssueComment:${repo.dbId}:${issue.number}:${commentId}`, 'utf8').toString('base64'),
            body: commentBody,
            createdAt: now,
            updatedAt: now,
          };
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id,
            node_id: comment.globalId,
            body: comment.body,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
          });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({
            id: c.id,
            node_id: c.globalId,
            body: c.body,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            created_at: c.createdAt,
            updated_at: c.updatedAt,
          })));
          return;
        }
        sendJson(res, 404, err('Not Found'));
        return;
      }
      sendJson(res, 404, err('Not Found'));
      return;
    }

    // -- pulls -----------------------------------------------------------------
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
          let head = typeof bodyObj.head === 'string' ? bodyObj.head : '';
          let base = typeof bodyObj.base === 'string' ? bodyObj.base : '';
          if (head.includes(':')) head = head.split(':').pop() ?? head;
          if (base.includes(':')) base = base.split(':').pop() ?? base;
          if (title === '' || head === '' || base === '') {
            sendJson(res, 422, err('title, head and base are required'));
            return;
          }
          const headSha = store.branchTip(repo, head);
          const baseSha = store.branchTip(repo, base);
          if (headSha === undefined || baseSha === undefined) {
            sendJson(res, 422, err('Head or base branch not found'));
            return;
          }
          const pull = store.createPull(repo, title, typeof bodyObj.body === 'string' ? bodyObj.body : '', head, base, headSha, baseSha);
          sendJson(res, 201, pullShape(repo, pull));
          return;
        }
        if (method === 'GET') {
          let pulls = [...repo.pulls];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const { page } = paginate(pulls, query);
          sendJson(res, 200, page.map((p) => pullShape(repo, p)));
          return;
        }
        sendJson(res, 404, err('Not Found'));
        return;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) {
        sendJson(res, 404, err('Not Found'));
        return;
      }
      const pull = repo.pulls.find((p) => p.number === number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (pull === undefined) {
            sendJson(res, 404, err('Not Found'));
            return;
          }
          sendJson(res, 200, pullShape(repo, pull));
          return;
        }
        sendJson(res, 404, err('Not Found'));
        return;
      }
      if (rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        const files = pullFiles(store, repo, pull);
        sendJson(res, 200, files);
        return;
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          sendJson(res, 404, err('Not Found'));
          return;
        }
        if (pull.state !== 'open') {
          sendJson(res, 405, err('Pull request is not open'));
          return;
        }
        const sha = store.squashMerge(repo, pull);
        if (sha === null) {
          sendJson(res, 405, err('Merge conflict'));
          return;
        }
        sendJson(res, 200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
        return;
      }
      sendJson(res, 404, err('Not Found'));
      return;
    }

    sendJson(res, 404, err('Not Found'));
    return;
  }

  sendJson(res, 404, err('Not Found'));
}

function dirEntries(repo: Repo, tip: string, dirPath: string, entries: Array<{ mode: string; name: string; oid: string }>): Array<Record<string, unknown>> {
  void tip;
  return entries.map((entry) => {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const object = repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (object?.data.length ?? 0),
      name: entry.name,
      path,
      sha: entry.oid,
    };
  });
}

function pullFiles(store: Store, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const base = mergeBase(repo.objects.get.bind(repo.objects), pull.baseSha, pull.headSha);
  if (base === null) return [];
  const baseCommit = repo.objects.get(base);
  const headCommit = repo.objects.get(pull.headSha);
  if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit') return [];
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  return store.diffFiles(repo, baseTree, headTree).map((change) => {
    const counts = store.lineCounts(repo, change.oldOid, change.newOid);
    return {
      filename: change.path,
      status: change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    };
  });
}
