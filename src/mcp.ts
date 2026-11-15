// MCP: the Model Context Protocol endpoint at POST /mcp (Streamable HTTP, plain JSON replies).
//
// Both eras the suite accepts are served: the modern 2026-07-28 `server/discover` (supported
// versions, capabilities, identity in one answer) and the legacy `initialize` +
// `notifications/initialized` handshake. Every tool result carries both a text content block
// (JSON) and a structuredContent object, because the checks read either. Unknown tools answer a
// JSON-RPC error, never HTTP 500; a non-JSON body answers HTTP 400 with -32700; a tools/call
// without an Authorization header answers HTTP 401.

import { VIEWER } from './scenario.ts';
import { NotFoundError, Store, ValidationError } from './store.ts';

export interface McpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const SERVER_NAME = 'github-forge-v02';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
  run: (args: Record<string, unknown>, store: Store) => Record<string, unknown>;
}

/** The six tools, in a fixed order; the array is built once so two tools/list answers are identical. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (args, store) => {
      const name = args.name as string;
      const repo = store.createRepo(
        VIEWER.login,
        name,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      const r = repo.record;
      return {
        id: r.id,
        name: r.name,
        full_name: r.fullName,
        owner: { login: r.owner },
        private: r.private,
        description: r.description,
        default_branch: r.defaultBranch,
      };
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args, store) => {
      const repo = store.getRepo(args.owner as string, args.repo as string);
      const r = repo.record;
      return {
        id: r.id,
        name: r.name,
        full_name: r.fullName,
        owner: { login: r.owner },
        private: r.private,
        description: r.description,
        default_branch: r.defaultBranch,
      };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args, store) => {
      const repo = store.getRepo(args.owner as string, args.repo as string);
      const issue = store.createIssue(
        repo,
        args.title as string,
        typeof args.body === 'string' ? args.body : '',
        [],
        VIEWER.login,
      );
      return {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
        user: { login: issue.userLogin },
      };
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args, store) => {
      const repo = store.getRepo(args.owner as string, args.repo as string);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = store.listIssues(repo, state);
      return {
        issues: issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels,
          user: { login: issue.userLogin },
        })),
      };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args, store) => {
      const repo = store.getRepo(args.owner as string, args.repo as string);
      const pull = store.createPull(
        repo,
        args.title as string,
        typeof args.body === 'string' ? args.body : '',
        args.head as string,
        args.base as string,
        VIEWER.login,
      );
      const headOid = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
      const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
      return {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        head: { ref: pull.headRef, sha: headOid },
        base: { ref: pull.baseRef, sha: baseOid },
      };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args, store) => {
      const repo = store.getRepo(args.owner as string, args.repo as string);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const { pull, commit } = store.mergePull(repo, number, 'squash');
      return { number: pull.number, merged: true, state: pull.state, sha: commit.oid, merge_commit_sha: commit.oid };
    },
  },
];

const TOOLS_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

function jsonRpcResult(id: unknown, result: unknown): McpResult {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8'),
  };
}

function jsonRpcError(id: unknown, code: number, message: string): McpResult {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), 'utf8'),
  };
}

function toolResult(id: unknown, structured: Record<string, unknown>): McpResult {
  return jsonRpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  });
}

function toolErrorResult(id: unknown, message: string): McpResult {
  return jsonRpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  });
}

/** Handle one POST /mcp request. */
export function handleMcp(store: Store, authorization: string | undefined, rawBody: Buffer): McpResult {
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    request = parsed as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'),
    };
  }
  const id = request.id ?? null;
  const method = request.method as string | undefined;
  const params = (request.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is acknowledged with 202 and no body.
  if (id === null && method !== undefined && method.startsWith('notifications/')) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  switch (method) {
    case 'server/discover':
      return jsonRpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'tools/list':
      return jsonRpcResult(id, { tools: TOOLS_LIST });
    case 'tools/call': {
      if (!authorization || !/^Bearer\s+\S+$/.test(authorization)) {
        return { status: 401, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ message: 'Requires authentication' }), 'utf8') };
      }
      const name = params.name as string | undefined;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        return jsonRpcError(id, -32602, `Unknown tool: ${name ?? ''}`);
      }
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return toolErrorResult(id, `Missing required argument: ${required}`);
        }
      }
      try {
        const result = tool.run(args, store);
        return toolResult(id, result);
      } catch (err) {
        if (err instanceof NotFoundError || err instanceof ValidationError) {
          return toolErrorResult(id, err.message);
        }
        throw err;
      }
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method ?? ''}`);
  }
}
