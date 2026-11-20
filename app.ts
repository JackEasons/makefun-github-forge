// app.ts — the forge's HTTP server: routing, auth, request ids, and the
// JSON envelope every REST reply carries. One process, standard library only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Forge } from './src/store.ts';
import { handleGit, splitGitPath } from './src/git.ts';
import { handleRest, type RestRequest } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function requestId(): string {
  return randomUUID();
}

function send(response: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | string): void {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  response.writeHead(status, { ...headers, 'content-length': String(data.length) });
  response.end(data);
}

function sendJson(response: ServerResponse, id: string, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = value === null ? '' : JSON.stringify(value);
  send(response, status, { ...JSON_HEADERS, 'x-github-request-id': id, ...extraHeaders }, body);
}

/** The bearer token authorizes; when the entry runs without one, any non-empty bearer is accepted. */
function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const token = match[1].trim();
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function createApp(): ReturnType<typeof createServer> {
  const forge = new Forge();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const id = requestId();
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;
      const method = (request.method ?? 'GET').toUpperCase();
      const headers = new Map<string, string>();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(key.toLowerCase(), value);
      }

      // GET /healthz — no auth, always available.
      if (pathname === '/healthz' && method === 'GET') {
        sendJson(response, id, 200, { ok: true });
        return;
      }

      // Git smart HTTP — the git client authenticates the same way, but the
      // protocol itself carries no auth challenge, so these paths are open.
      // GETs (info/refs) never carry a body, so skip the readBody wait: it
      // costs an extra event-loop turn per request on a path the clone
      // workload hits three times per clone.
      if (splitGitPath(pathname) !== null) {
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);
        const result = handleGit(forge, { method, pathname, query: url.searchParams, headers, body });
        if (result !== null) {
          send(response, result.status, { 'content-type': result.contentType, 'x-github-request-id': id }, result.body);
          return;
        }
        sendJson(response, id, 404, { message: 'Not Found' });
        return;
      }

      // POST /api/graphql
      if (pathname === '/api/graphql' && method === 'POST') {
        if (!authorized(request)) {
          sendJson(response, id, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(request);
        let parsed: unknown = null;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(response, id, 400, { message: 'Problems parsing JSON' });
            return;
          }
        }
        const result = executeGraphQL(forge, parsed);
        sendJson(response, id, result.status, result.value);
        return;
      }

      // POST /mcp
      if (pathname === '/mcp' && method === 'POST') {
        if (!authorized(request)) {
          sendJson(response, id, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(request);
        const result = handleMcp(forge, body);
        if (result.body === null) {
          send(response, result.status, { 'x-github-request-id': id }, '');
          return;
        }
        sendJson(response, id, result.status, result.body);
        return;
      }

      // REST v3 under /api/v3
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        // The root and meta endpoints answer without a token; everything else
        // requires the bearer token.
        const needsAuth = !(pathname === '/api/v3' || pathname === '/api/v3/meta');
        if (needsAuth && !authorized(request)) {
          sendJson(response, id, 401, { message: 'Requires authentication' });
          return;
        }
        let parsedBody: Record<string, unknown> | null = null;
        let rawBody: Buffer = Buffer.alloc(0);
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          rawBody = await readBody(request);
          if (rawBody.length > 0) {
            try {
              const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
              parsedBody = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
            } catch {
              sendJson(response, id, 400, { message: 'Problems parsing JSON' });
              return;
            }
          } else {
            parsedBody = {};
          }
        }
        const restRequest: RestRequest = {
          method,
          pathname,
          query: url.searchParams,
          body: parsedBody,
          rawBody,
          headers,
          host: request.headers.host ?? 'localhost',
        };
        const result = handleRest(forge, restRequest);
        if (result === null) {
          sendJson(response, id, 404, { message: 'Not Found' });
          return;
        }
        if (result.status === 204) {
          send(response, 204, { 'x-github-request-id': id }, '');
          return;
        }
        sendJson(response, id, result.status, result.body, result.headers ?? {});
        return;
      }

      sendJson(response, id, 404, { message: 'Not Found' });
    } catch (err) {
      console.error('request failed:', err instanceof Error ? err.message : String(err));
      if (!response.headersSent) {
        try {
          sendJson(response, id, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    }
  });
  return server;
}
