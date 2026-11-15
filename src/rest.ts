// REST v3: the /api/v3 surface.
//
// Routes follow the kit's rest-client contract: JSON everywhere, a non-empty
// X-GitHub-Request-Id on every reply, 4xx bodies of the shape {"message": string}, 401 without a
// bearer token, 400 for a malformed JSON body, and JSON 404 for unknown routes. Repository,
// issue and pull-request bodies echo GitHub's field names (snake_case), with labels as
// {name, color} objects.

import { b64decode, b64encode, isOid } from './util.ts';
import { VIEWER } from './scenario.ts';
import {
  AlreadyExistsError,
  ConflictError,
  NotFoundError,
  Store,
  ValidationError,
  commitParents,
  type IssueRecord,
  type PullRecord,
  type Repo,
} from './store.ts';
import { makeObject, parseCommit, EMPTY_TREE_OID } from './gitcore.ts';

export interface RestResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  baseUrl: string;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}

function json(status: number, value: JsonValue | null, extraHeaders: Record<string, string> = {}): RestResult {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  return { status, headers, body: Buffer.from(value === null ? '' : JSON.stringify(value), 'utf8') };
}

function error(status: number, message: string): RestResult {
  return json(status, { message });
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function repoJson(repo: Repo): Record<string, JsonValue> {
  const r = repo.record;
  return {
    id: r.id,
    node_id: b64encode(Buffer.from(`Repository:${r.id}`, 'utf8')),
    name: r.name,
    full_name: r.fullName,
    owner: { login: r.owner, id: 1000, type: 'User' },
    private: r.private,
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
    html_url: `https://github.com/${r.fullName}`,
    url: `/api/v3/repos/${r.fullName}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, JsonValue> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(repo: Repo, issue: IssueRecord): Record<string, JsonValue> {
  return {
    id: issue.id,
    node_id: b64encode(Buffer.from(`Issue:${issue.id}`, 'utf8')),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: { login: issue.userLogin, id: 1000, type: 'User' },
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : iso(issue.closedAt),
    html_url: `https://github.com/${repo.record.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.record.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRecord): Record<string, JsonValue> {
  const headOid = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    node_id: b64encode(Buffer.from(`PullRequest:${pull.id}`, 'utf8')),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headOid, label: `${repo.record.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseOid, label: `${repo.record.owner}:${pull.baseRef}` },
    user: { login: pull.userLogin, id: 1000, type: 'User' },
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
    html_url: `https://github.com/${repo.record.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.record.fullName}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, JsonValue> | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const fields = parseCommit(obj.data);
  const messageEnd = obj.data.indexOf('\n\n');
  const message = messageEnd === -1 ? '' : obj.data.subarray(messageEnd + 2).toString('utf8');
  const authorLine = fields.get('author') ?? '';
  const authorName = authorLine.split('<')[0]?.trim() ?? '';
  const authorEmail = authorLine.match(/<([^>]*)>/)?.[1] ?? '';
  return {
    sha: oid,
    node_id: b64encode(Buffer.from(`Commit:${oid}`, 'utf8')),
    commit: {
      message,
      author: { name: authorName, email: authorEmail, date: iso(repo.record.createdAt) },
      committer: { name: authorName, email: authorEmail, date: iso(repo.record.createdAt) },
    },
    author: { login: VIEWER.login, id: 1000, type: 'User' },
    committer: { login: VIEWER.login, id: 1000, type: 'User' },
    parents: commitParents(obj.data).map((sha) => ({ sha })),
    url: `/api/v3/repos/${repo.record.fullName}/commits/${oid}`,
  };
}

function parseJsonBody(request: RestRequest): Record<string, unknown> {
  if (request.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(request.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError('Malformed JSON body');
  }
}

function requireFields(body: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new ValidationError(`Missing required field: ${field}`);
    }
  }
}

function stringField(body: Record<string, unknown>, field: string, fallback = ''): string {
  const value = body[field];
  return typeof value === 'string' ? value : fallback;
}

function booleanField(body: Record<string, unknown>, field: string, fallback = false): boolean {
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** The main REST dispatcher. `request.path` is the path after /api/v3 (or the full path). */
export function handleRest(store: Store, request: RestRequest): RestResult {
  // Authentication: every /api/v3 route needs a non-empty bearer token.
  const authorization = request.headers['authorization'] ?? '';
  if (!/^Bearer\s+\S+$/.test(authorization)) {
    return error(401, 'Requires authentication');
  }
  const rawPath = request.path.startsWith('/api/v3') ? request.path.slice('/api/v3'.length) : request.path;
  const path = rawPath === '' ? '/' : rawPath;
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const method = request.method.toUpperCase();

  try {
    // Root and meta.
    if (segments.length === 0) {
      if (method !== 'GET') return error(404, 'Not Found');
      return json(200, { current_user_url: `${request.baseUrl}/api/v3/user` }, { 'x-oauth-scopes': 'repo, read:user' });
    }
    if (segments[0] === 'meta' && segments.length === 1) {
      if (method !== 'GET') return error(404, 'Not Found');
      return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    }
    if (segments[0] === 'user' && segments.length === 1) {
      if (method !== 'GET') return error(404, 'Not Found');
      return json(200, { login: VIEWER.login, id: 1000, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    }
    if (segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'POST' && segments.length === 2) return createUserRepo(store, request);
      if (method === 'GET' && segments.length === 2) return listUserRepos(store, request);
      return error(404, 'Not Found');
    }
    if (segments[0] === 'repos' && segments.length >= 3) {
      return handleRepoRoute(store, request, segments);
    }
    return error(404, 'Not Found');
  } catch (err) {
    if (err instanceof ValidationError) return error(400, err.message);
    if (err instanceof NotFoundError) return error(404, err.message);
    if (err instanceof AlreadyExistsError) return error(422, err.message);
    if (err instanceof ConflictError) return error(409, err.message);
    throw err;
  }
}

function createUserRepo(store: Store, request: RestRequest): RestResult {
  const body = parseJsonBody(request);
  requireFields(body, ['name']);
  const name = stringField(body, 'name');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
    throw new ValidationError('Invalid repository name');
  }
  const repo = store.createRepo(
    VIEWER.login,
    name,
    stringField(body, 'description'),
    booleanField(body, 'private', false),
  );
  return json(201, repoJson(repo));
}

function listUserRepos(store: Store, request: RestRequest): RestResult {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(request.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(request.query.get('page') ?? '1', 10) || 1);
  const all = store.listReposByOwner(VIEWER.login);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const nextUrl = `${request.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    headers['link'] = `<${nextUrl}>; rel="next"`;
  }
  return json(200, slice.map((repo) => repoJson(repo)) as unknown as JsonValue, headers);
}

function handleRepoRoute(store: Store, request: RestRequest, segments: string[]): RestResult {
  const [, owner, name, ...rest] = segments;
  const method = request.method.toUpperCase();
  const repo = store.getRepo(owner as string, name as string);

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const body = parseJsonBody(request);
      if (typeof body.description === 'string') repo.record.description = body.description;
      if (typeof body.default_branch === 'string') repo.record.defaultBranch = body.default_branch;
      repo.record.updatedAt = store.clock.now();
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner as string, name as string);
      return json(204, null);
    }
    return error(404, 'Not Found');
  }

  const [head, ...tail] = rest as string[];
  if (head === 'branches') return handleBranches(store, repo, request, tail);
  if (head === 'git' && tail[0] === 'refs') return handleGitRefs(store, repo, request, tail.slice(1));
  if (head === 'commits') return handleCommits(store, repo, request, tail);
  if (head === 'contents') return handleContents(store, repo, request, tail);
  if (head === 'labels') return handleLabels(store, repo, request, tail);
  if (head === 'issues') return handleIssues(store, repo, request, tail);
  if (head === 'pulls') return handlePulls(store, repo, request, tail);
  return error(404, 'Not Found');
}

function handleBranches(store: Store, repo: Repo, request: RestRequest, tail: string[]): RestResult {
  const method = request.method.toUpperCase();
  if (method !== 'GET') return error(404, 'Not Found');
  if (tail.length === 0) {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref) as string, url: `/api/v3/repos/${repo.record.fullName}/commits/${repo.refs.get(ref) as string}` },
        protected: false,
      }));
    return json(200, branches as unknown as JsonValue);
  }
  const branch = decodeURIComponent(tail.join('/'));
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) return error(404, `Branch ${branch} not found`);
  return json(200, {
    name: branch,
    commit: { sha: oid, url: `/api/v3/repos/${repo.record.fullName}/commits/${oid}` },
    protected: false,
  });
}

function handleGitRefs(store: Store, repo: Repo, request: RestRequest, tail: string[]): RestResult {
  const method = request.method.toUpperCase();
  if (method === 'POST' && tail.length === 0) {
    const body = parseJsonBody(request);
    requireFields(body, ['ref', 'sha']);
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (!ref.startsWith('refs/')) throw new ValidationError('ref must start with refs/');
    if (!isOid(sha) || !repo.objects.has(sha)) throw new ValidationError('sha does not exist');
    if (repo.refs.has(ref)) throw new AlreadyExistsError(`Reference ${ref} already exists`);
    store.setRef(repo, ref, sha);
    return json(201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.record.fullName}/git/commits/${sha}` } });
  }
  if (method === 'GET' && tail.length > 0) {
    const ref = `refs/${tail.map((segment) => decodeURIComponent(segment)).join('/')}`;
    const oid = repo.refs.get(ref);
    if (!oid) return error(404, `Reference ${ref} not found`);
    return json(200, { ref, object: { sha: oid, type: 'commit', url: `/api/v3/repos/${repo.record.fullName}/git/commits/${oid}` } });
  }
  return error(404, 'Not Found');
}

function handleCommits(store: Store, repo: Repo, request: RestRequest, tail: string[]): RestResult {
  const method = request.method.toUpperCase();
  if (method !== 'GET') return error(404, 'Not Found');
  if (tail.length === 1) {
    const oid = decodeURIComponent(tail[0] as string);
    const body = commitJson(repo, oid);
    if (!body) return error(404, `Commit ${oid} not found`);
    return json(200, body);
  }
  if (tail.length === 0) {
    const shaParam = request.query.get('sha');
    const startOid = shaParam ? repo.refs.get(`refs/heads/${shaParam}`) ?? shaParam : store.headOid(repo);
    const commits: Array<Record<string, JsonValue>> = [];
    if (startOid) {
      const seen = new Set<string>();
      const queue = [startOid];
      while (queue.length) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const body = commitJson(repo, oid);
        if (!body) continue;
        commits.push(body);
        for (const parent of commitParents(repo.objects.get(oid)?.data ?? Buffer.alloc(0))) {
          queue.push(parent);
        }
      }
    }
    return json(200, commits as unknown as JsonValue);
  }
  return error(404, 'Not Found');
}

function handleContents(store: Store, repo: Repo, request: RestRequest, tail: string[]): RestResult {
  const method = request.method.toUpperCase();
  const path = tail.map((segment) => decodeURIComponent(segment)).join('/');
  if (path.length === 0) return error(404, 'Not Found');
  const refParam = request.query.get('ref');
  const branch = refParam ?? repo.record.defaultBranch;
  const ref = refParam && repo.refs.has(`refs/heads/${refParam}`)
    ? `refs/heads/${refParam}`
    : refParam && repo.refs.has(refParam)
      ? refParam
      : `refs/heads/${branch}`;
  const treeOid = store.treeOidForRef(repo, ref);

  if (method === 'GET') {
    const flat = store.flattenTree(repo, treeOid);
    const exact = flat.get(path);
    if (exact && exact.type === 'blob') {
      const blob = repo.objects.get(exact.oid);
      if (!blob) return error(404, `Path ${path} not found`);
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() as string,
        path,
        content: b64encode(blob.data),
        sha: exact.oid,
        url: `/api/v3/repos/${repo.record.fullName}/contents/${path}`,
        html_url: `https://github.com/${repo.record.fullName}/blob/${branch}/${path}`,
        git_url: `/api/v3/repos/${repo.record.fullName}/git/blobs/${exact.oid}`,
        download_url: `/api/v3/repos/${repo.record.fullName}/contents/${path}`,
      });
    }
    // Directory listing: immediate children of the path.
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
    for (const [filePath, entry] of flat) {
      if (filePath === path && entry.type === 'tree') continue;
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        children.set(rest, { type: entry.type === 'tree' ? 'dir' : 'file', name: rest, path: filePath, sha: entry.oid, size: 0 });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          const dirEntry = flat.get(`${path}/${dirName}`);
          children.set(dirName, { type: 'dir', name: dirName, path: `${path}/${dirName}`, sha: dirEntry?.oid ?? EMPTY_TREE_OID, size: 0 });
        }
      }
    }
    if (children.size === 0 && !exact) return error(404, `Path ${path} not found`);
    const listing = [...children.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((child) => ({
        type: child.type,
        name: child.name,
        path: child.path,
        sha: child.sha,
        size: child.size,
        url: `/api/v3/repos/${repo.record.fullName}/contents/${child.path}`,
        html_url: `https://github.com/${repo.record.fullName}/tree/${branch}/${child.path}`,
        git_url: `/api/v3/repos/${repo.record.fullName}/git/trees/${child.sha}`,
        download_url: null,
      }));
    return json(200, listing as unknown as JsonValue);
  }

  if (method === 'PUT') {
    const body = parseJsonBody(request);
    requireFields(body, ['message', 'content']);
    const message = stringField(body, 'message');
    const content = b64decode(stringField(body, 'content'));
    const putBranch = typeof body.branch === 'string' ? body.branch : repo.record.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const existed = store.flattenTree(repo, store.treeOidForRef(repo, `refs/heads/${putBranch}`)).has(path);
    const commit = store.applyContentChange(repo, putBranch, path, content, message, sha);
    const blobOid = hashObjectBlob(content);
    return json(existed ? 200 : 201, {
      content: { name: path.split('/').pop() as string, path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commit.oid, message },
    });
  }

  if (method === 'DELETE') {
    const body = parseJsonBody(request);
    requireFields(body, ['message', 'sha']);
    const message = stringField(body, 'message');
    const sha = stringField(body, 'sha');
    const deleteBranch = typeof body.branch === 'string' ? body.branch : repo.record.defaultBranch;
    const commit = store.applyContentChange(repo, deleteBranch, path, null, message, sha);
    return json(200, { commit: { sha: commit.oid, message } });
  }
  return error(404, 'Not Found');
}

function hashObjectBlob(content: Buffer): string {
  return makeObject('blob', content).oid;
}

function handleLabels(store: Store, repo: Repo, request: RestRequest, tail: string[]): RestResult {
  const method = request.method.toUpperCase();
  if (method === 'GET' && tail.length === 0) {
    return json(200, [...repo.labels.values()].map((label) => labelJson(label)) as unknown as JsonValue);
  }
  if (method === 'POST' && tail.length === 0) {
    const body = parseJsonBody(request);
    requireFields(body, ['name']);
    const label = store.createLabel(repo, stringField(body, 'name'), stringField(body, 'color', 'ededed'), stringField(body, 'description'));
    return json(201, labelJson(label));
  }
  return error(404, 'Not Found');
}

function handleIssues(store: Store, repo: Repo, request: RestRequest, tail: string[]): RestResult {
  const method = request.method.toUpperCase();
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(request);
      requireFields(body, ['title']);
      const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      try {
        const issue = store.createIssue(repo, stringField(body, 'title'), stringField(body, 'body'), labels, VIEWER.login);
        return json(201, issueJson(repo, issue));
      } catch (err) {
        if (err instanceof ValidationError) return error(422, err.message);
        throw err;
      }
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? undefined;
      const sort = (request.query.get('sort') ?? 'created') as 'created' | 'updated';
      const direction = (request.query.get('direction') ?? 'desc') as 'asc' | 'desc';
      const issues = store.listIssues(repo, state, sort === 'updated' ? 'updated' : 'created', direction === 'asc' ? 'asc' : 'desc');
      return json(200, issues.map((issue) => issueJson(repo, issue)) as unknown as JsonValue);
    }
    return error(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) return error(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return json(200, issueJson(repo, store.getIssue(repo, number)));
    if (method === 'PATCH') {
      const body = parseJsonBody(request);
      const patch: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: string[] } = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.body === 'string') patch.body = body.body;
      if (body.state === 'open' || body.state === 'closed') patch.state = body.state;
      if (Array.isArray(body.labels)) patch.labels = (body.labels as unknown[]).filter((l): l is string => typeof l === 'string');
      try {
        const issue = store.updateIssue(repo, number, patch);
        return json(200, issueJson(repo, issue));
      } catch (err) {
        if (err instanceof ValidationError) return error(422, err.message);
        throw err;
      }
    }
    return error(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const body = parseJsonBody(request);
      requireFields(body, ['body']);
      const comment = store.createComment(repo, number, stringField(body, 'body'), VIEWER.login);
      return json(201, { id: comment.id, body: comment.body, user: { login: comment.userLogin, id: 1000, type: 'User' }, created_at: iso(comment.createdAt), updated_at: iso(comment.createdAt) });
    }
    if (method === 'GET') {
      const comments = store.listComments(repo, number);
      return json(200, comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: comment.userLogin, id: 1000, type: 'User' },
        created_at: iso(comment.createdAt),
        updated_at: iso(comment.createdAt),
      })) as unknown as JsonValue);
    }
  }
  return error(404, 'Not Found');
}

function handlePulls(store: Store, repo: Repo, request: RestRequest, tail: string[]): RestResult {
  const method = request.method.toUpperCase();
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(request);
      requireFields(body, ['title', 'head', 'base']);
      try {
        const pull = store.createPull(repo, stringField(body, 'title'), stringField(body, 'body'), stringField(body, 'head'), stringField(body, 'base'), VIEWER.login);
        return json(201, pullJson(repo, pull));
      } catch (err) {
        if (err instanceof ValidationError) return error(422, err.message);
        throw err;
      }
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const pulls = store.listPulls(repo, state);
      return json(200, pulls.map((pull) => pullJson(repo, pull)) as unknown as JsonValue);
    }
    return error(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) return error(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return json(200, pullJson(repo, store.getPull(repo, number)));
    return error(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return error(404, 'Not Found');
    const pull = store.getPull(repo, number);
    const files = store.pullFiles(repo, pull);
    return json(200, files as unknown as JsonValue);
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return error(404, 'Not Found');
    const body = parseJsonBody(request);
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
    try {
      const { pull, commit } = store.mergePull(repo, number, mergeMethod);
      return json(200, { sha: commit.oid, merged: true, message: pull.title });
    } catch (err) {
      if (err instanceof ConflictError) return error(405, err.message);
      if (err instanceof ValidationError) return error(422, err.message);
      throw err;
    }
  }
  return error(404, 'Not Found');
}
