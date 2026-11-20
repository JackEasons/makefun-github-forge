// mcp.ts — the MCP surface: JSON-RPC 2.0 over POST /mcp (plain JSON, no SSE).
// Six tools (create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request), each with a static schema so
// tools/list is byte-identical across calls.

import type { Forge } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  handler: (forge: Forge, args: Record<string, unknown>) => { ok: boolean; data: unknown; error?: string };
}

function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function errorResult(message: string): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError: true } {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

/** Pick the first present argument among synonyms (case-insensitive keys). */
function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  const lower = new Map<string, unknown>();
  for (const [key, value] of Object.entries(args)) lower.set(key.toLowerCase(), value);
  for (const name of names) {
    const value = lower.get(name.toLowerCase());
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    handler: (forge, args) => {
      const name = str(pick(args, 'name', 'repo', 'repository'));
      if (!name) return { ok: false, data: null, error: 'name is required' };
      if (forge.getRepo(VIEWER_LOGIN, name)) return { ok: false, data: null, error: `A repository named '${name}' already exists` };
      const repo = forge.createRepo(name, {
        private: pick(args, 'private') === true,
        description: str(pick(args, 'description')) ?? '',
      });
      return { ok: true, data: { name: repo.name, private: repo.private, default_branch: repo.defaultBranch, owner: repo.owner } };
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (forge, args) => {
      const owner = str(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login'));
      const repoName = str(pick(args, 'repo', 'repository', 'name'));
      if (!owner || !repoName) return { ok: false, data: null, error: 'owner and repo are required' };
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { ok: false, data: null, error: 'Not Found' };
      return {
        ok: true,
        data: { name: repo.name, owner: repo.owner, private: repo.private, default_branch: repo.defaultBranch, description: repo.description },
      };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
        labels: { type: 'array', description: 'Labels to apply to the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    handler: (forge, args) => {
      const owner = str(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login'));
      const repoName = str(pick(args, 'repo', 'repository', 'name'));
      const title = str(pick(args, 'title'));
      if (!owner || !repoName || !title) return { ok: false, data: null, error: 'owner, repo and title are required' };
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { ok: false, data: null, error: 'Not Found' };
      const labels = Array.isArray(pick(args, 'labels')) ? (pick(args, 'labels') as unknown[]).filter((v): v is string => typeof v === 'string') : [];
      const created = forge.createIssue(repo, title, str(pick(args, 'body')) ?? '', labels);
      if ('error' in created) return { ok: false, data: null, error: created.error };
      return { ok: true, data: { number: created.number, title: created.title, body: created.body, state: created.state } };
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (forge, args) => {
      const owner = str(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login'));
      const repoName = str(pick(args, 'repo', 'repository', 'name'));
      if (!owner || !repoName) return { ok: false, data: null, error: 'owner and repo are required' };
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { ok: false, data: null, error: 'Not Found' };
      const state = str(pick(args, 'state')) ?? 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return {
        ok: true,
        data: issues.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
      };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    handler: (forge, args) => {
      const owner = str(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login'));
      const repoName = str(pick(args, 'repo', 'repository', 'name'));
      const title = str(pick(args, 'title'));
      const head = str(pick(args, 'head', 'head_ref', 'head_branch'));
      const base = str(pick(args, 'base', 'base_ref', 'base_branch'));
      if (!owner || !repoName || !title || !head || !base) {
        return { ok: false, data: null, error: 'owner, repo, title, head and base are required' };
      }
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { ok: false, data: null, error: 'Not Found' };
      const created = forge.createPull(repo, { title, body: str(pick(args, 'body')) ?? '', head, base });
      if ('error' in created) return { ok: false, data: null, error: created.error };
      return {
        ok: true,
        data: { number: created.number, title: created.title, state: created.state, head: created.head, base: created.base },
      };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    handler: (forge, args) => {
      const owner = str(pick(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login'));
      const repoName = str(pick(args, 'repo', 'repository', 'name'));
      const rawNumber = pick(args, 'pull_number', 'number', 'pr_number', 'pull_request_number');
      const pullNumber = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : NaN;
      if (!owner || !repoName || !Number.isInteger(pullNumber)) {
        return { ok: false, data: null, error: 'owner, repo and pull_number are required' };
      }
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return { ok: false, data: null, error: 'Not Found' };
      const pr = forge.getPull(repo, pullNumber);
      if (!pr) return { ok: false, data: null, error: 'Not Found' };
      const merged = forge.mergePull(repo, pr);
      if ('status' in merged) return { ok: false, data: null, error: merged.message };
      return { ok: true, data: { number: pr.number, merged: true, sha: merged.sha, state: pr.state } };
    },
  },
];

const TOOLS_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS_LIST });

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function handleMcp(forge: Forge, rawBody: Buffer): McpResult {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  const id = request.id ?? null;
  const method = request.method;
  if (typeof method !== 'string') {
    return { status: 400, body: rpcError(id, -32600, 'Invalid Request') };
  }

  // Notifications carry no id and expect no response body.
  if (id === null || id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: null };
    }
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }

  if (method === 'server/discover') {
    return { status: 200, body: rpcError(id, -32601, 'Method not found') };
  }

  if (method === 'initialize') {
    const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params
      : {}) as Record<string, unknown>;
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' },
        },
      },
    };
  }

  if (method === 'tools/list') {
    // Byte-identical across calls: the list is built once, above.
    return { status: 200, body: { jsonrpc: '2.0', id, result: JSON.parse(TOOLS_LIST_JSON) as unknown } };
  }

  if (method === 'tools/call') {
    const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params
      : {}) as Record<string, unknown>;
    const name = params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool ${String(name)}`) };
    }
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {}) as Record<string, unknown>;
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, result: errorResult(`missing required argument: ${missing.join(', ')}`) },
      };
    }
    const outcome = tool.handler(forge, args);
    if (!outcome.ok) {
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, result: errorResult(outcome.error ?? 'tool failed') },
      };
    }
    return { status: 200, body: { jsonrpc: '2.0', id, result: toolResult(outcome.data) } };
  }

  if (method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }

  return { status: 200, body: rpcError(id, -32601, 'Method not found') };
}
