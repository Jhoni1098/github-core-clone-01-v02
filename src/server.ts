// The HTTP server: one process, four surfaces over one store.
//
//   GET  /healthz                                  → 200 {"ok":true}
//   GET  /:owner/:repo/info/refs?service=...       → git advertisement
//   POST /:owner/:repo/git-upload-pack             → ls-refs / fetch
//   POST /:owner/:repo/git-receive-pack            → push
//   /api/v3/...                                    → REST v3
//   POST /api/graphql                              → GraphQL
//   POST /mcp                                      → MCP (JSON-RPC over Streamable HTTP)
//
// Everything else answers a JSON 404. Bodies are read whole (64 MiB cap) before dispatch; git
// bodies stay binary, REST/GraphQL/MCP bodies are parsed by their own handlers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitHttpResult } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
  response.writeHead(status, headers);
  response.end(body);
}

function json404(message: string): { status: number; headers: Record<string, string>; body: Buffer } {
  return {
    status: 404,
    headers: { 'content-type': 'application/json', 'x-github-request-id': `req-${Date.now().toString(36)}` },
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

export function createApp(store: Store): Server {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = (request.method ?? 'GET').toUpperCase();
      const host = request.headers.host ?? '127.0.0.1';
      const baseUrl = `http://${host}`;

      if (method === 'GET' && path === '/healthz') {
        send(response, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
        return;
      }

      // Git smart HTTP: /:owner/:repo.git/info/refs and /:owner/:repo.git/git-{upload,receive}-pack.
      const gitMatch = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        const [, owner, repoWithSuffix, service] = gitMatch as unknown as [string, string, string, string];
        // The smart-HTTP path carries a `.git` suffix on the repository name; strip it.
        const repo = repoWithSuffix.endsWith('.git') ? repoWithSuffix.slice(0, -4) : repoWithSuffix;
        if (service === 'info/refs' && method === 'GET') {
          const result: GitHttpResult = handleInfoRefs(store, owner as string, repo as string, url.searchParams.get('service') ?? '');
          send(response, result.status, { 'content-type': result.contentType }, result.body);
          return;
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(request);
          const result = handleUploadPack(store, owner as string, repo as string, body);
          send(response, result.status, { 'content-type': result.contentType }, result.body);
          return;
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(request);
          const result = await handleReceivePack(store, owner as string, repo as string, body);
          send(response, result.status, { 'content-type': result.contentType }, result.body);
          return;
        }
        const notFound = json404('Not Found');
        send(response, notFound.status, notFound.headers, notFound.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
        }
        const restRequest: RestRequest = { method, path, query: url.searchParams, headers, body, baseUrl };
        const result = handleRest(store, restRequest);
        send(response, result.status, result.headers, result.body);
        return;
      }

      // GraphQL.
      if (path === '/api/graphql' && method === 'POST') {
        const body = await readBody(request);
        const result = handleGraphQL(store, request.headers.authorization, body);
        send(response, result.status, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(result.body), 'utf8'));
        return;
      }

      // MCP.
      if (path === '/mcp' && method === 'POST') {
        const body = await readBody(request);
        const result = handleMcp(store, request.headers.authorization, body);
        send(response, result.status, result.headers, result.body);
        return;
      }

      const notFound = json404('Not Found');
      send(response, notFound.status, notFound.headers, notFound.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(response, 500, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ message }), 'utf8'));
    }
  });
  return server;
}
