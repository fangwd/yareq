import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { gzipSync, deflateRawSync, deflateSync } from 'zlib';

export interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const attempts = new Map<string, number>();
  const server = createServer((req, res) => {
    handleRequest(req, res, attempts).catch(error => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to start test server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  attempts: Map<string, number>
) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (url.pathname === '/') {
    sendJson(res, {
      method: req.method,
      url: req.url,
      headers: req.headers
    });
    return;
  }

  if (url.pathname === '/gzip') {
    const body = gzipSync('gzip');
    res.writeHead(200, {
      'Content-Encoding': 'gzip',
      'Content-Type': 'text/plain',
      'Content-Length': body.length
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/deflate') {
    const body = deflateSync('deflate');
    res.writeHead(200, {
      'Content-Encoding': 'deflate',
      'Content-Type': 'text/plain',
      'Content-Length': body.length
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/deflate-raw') {
    const body = deflateRawSync('deflate raw');
    res.writeHead(200, {
      'Content-Encoding': 'deflate',
      'Content-Type': 'text/plain',
      'Content-Length': body.length
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/echo') {
    const body = await readBody(req);
    res.writeHead(200, {
      'Content-Type': req.headers['content-type'] || 'text/plain',
      'Content-Length': body.length
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/large') {
    const body = Buffer.alloc(128 * 1024, 'a');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/redirect') {
    res.writeHead(301, { Location: '/info' });
    res.end();
    return;
  }

  if (url.pathname === '/redirect-to') {
    res.writeHead(302, { Location: url.searchParams.get('url') || '/' });
    res.end();
    return;
  }

  if (url.pathname === '/see-other') {
    res.writeHead(303, { Location: '/method' });
    res.end();
    return;
  }

  if (url.pathname === '/loop') {
    res.writeHead(302, { Location: '/loop' });
    res.end();
    return;
  }

  if (url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('info');
    return;
  }

  if (url.pathname === '/method') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(req.method || '');
    return;
  }

  if (url.pathname === '/timeout') {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('late');
    }, 200);
    return;
  }

  if (url.pathname === '/timeout-once') {
    const attempt = nextAttempt(attempts, url);
    if (attempt === 1) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('late');
      }, 100);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'X-Attempt': String(attempt)
    });
    res.end('ok');
    return;
  }

  if (url.pathname === '/cookie') {
    if (!req.headers.cookie) {
      res.setHeader('Set-Cookie', 'id=1; Path=/');
    }
    sendJson(res, { cookie: req.headers.cookie || null });
    return;
  }

  if (url.pathname === '/multi-cookie') {
    res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
    sendJson(res, { ok: true });
    return;
  }

  if (url.pathname === '/basic') {
    sendJson(res, { authorization: req.headers.authorization || null });
    return;
  }

  if (url.pathname === '/binary') {
    const body = Buffer.from([1, 2, 3]);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/retry-status') {
    const attempt = nextAttempt(attempts, url);
    if (attempt === 1) {
      res.writeHead(503, {
        'Content-Type': 'text/plain',
        'X-Attempt': String(attempt)
      });
      res.end('retry');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'X-Attempt': String(attempt)
    });
    res.end('ok');
    return;
  }

  if (url.pathname === '/multipart') {
    const body = await readBody(req);
    sendJson(res, {
      headers: req.headers,
      body: body.toString()
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

function nextAttempt(attempts: Map<string, number>, url: URL): number {
  const key = `${url.pathname}${url.search}`;
  const attempt = (attempts.get(key) || 0) + 1;
  attempts.set(key, attempt);
  return attempt;
}

function sendJson(res: ServerResponse, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': body.length
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
