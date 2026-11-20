// MCP over streamable HTTP (JSON-RPC 2.0, plain application/json answers).
// Modern era first: server/discover (2026-07-28), with the legacy initialize
// handshake as a fallback. Six tools, all acting on the same store as REST.

import { VIEWER, type Repo, type Store } from './store.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'mini-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface RepoJson {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string;
  private: boolean;
  default_branch: string;
}

export function repoJsonForMcp(repo: Repo): RepoJson {
  return {
    id: repo.dbId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
  };
}

function issueJsonForMcp(repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = owner === '' ? parts[0] : owner;
      repo = repo === '' ? parts[1] : repo;
    }
  }
  return { owner, repo };
}

function toolResult(content: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) }],
    structuredContent: content,
    ...(isError ? { isError: true } : {}),
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return toolResult({ error: `Missing required argument(s): ${missing.join(', ')}` }, true);
  }

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (store.getRepo(VIEWER.login, repoName) !== undefined) {
      return toolResult({ error: `Repository ${VIEWER.login}/${repoName} already exists` }, true);
    }
    const repo = store.createRepo(VIEWER.login, repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    return toolResult(repoJsonForMcp(repo));
  }

  const { owner, repo: repoName } = splitFullName(args);
  const repo = store.getRepo(owner, repoName);
  if (name === 'get_repo') {
    if (repo === undefined) return toolResult({ error: `Repository ${owner}/${repoName} not found` }, true);
    return toolResult(repoJsonForMcp(repo));
  }
  if (repo === undefined) return toolResult({ error: `Repository ${owner}/${repoName} not found` }, true);

  if (name === 'create_issue') {
    const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return toolResult(issueJsonForMcp(repo, issue));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const issues = repo.issues.filter((i) => state === 'all' || i.state === state);
    return toolResult({ issues: issues.map((i) => issueJsonForMcp(repo, i)) });
  }
  if (name === 'create_pull_request') {
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      return toolResult({ error: `Head or base branch not found: ${head} / ${base}` }, true);
    }
    const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
    return toolResult({
      id: pull.globalId,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
    });
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) return toolResult({ error: `Pull request #${number} not found` }, true);
    if (pull.state !== 'open') return toolResult({ error: `Pull request #${number} is not open` }, true);
    const sha = store.squashMerge(repo, pull);
    if (sha === null) return toolResult({ error: `Pull request #${number} has merge conflicts` }, true);
    return toolResult({ number: pull.number, merged: true, state: 'closed', sha, message: `Pull request #${number} merged` });
  }
  return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
}

export interface McpOutcome {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function extractId(text: string): unknown {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+|null)/.exec(text);
  if (match === null) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** Handle one POST /mcp body (already read as text). */
export function handleMcp(store: Store, rawBody: string): McpOutcome {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: rpcError(extractId(rawBody), -32700, 'Parse error') };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id: acknowledge with 202 and no body.
  if (req.id === undefined) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: MCP_TOOLS }) };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, toolName, args);
    if ('__rpcError' in outcome) {
      const err = outcome.__rpcError as { code: number; message: string };
      return { status: 200, body: rpcError(id, err.code, err.message) };
    }
    return { status: 200, body: rpcResult(id, outcome) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
