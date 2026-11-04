import { AddressInfo, connect, createServer, Server, Socket } from 'net';
import { readFileSync } from 'fs';
import { createServer as createHttpsServer, request as httpsRequest } from 'https';
import { join } from 'path';
import { request, RequestTimeoutError } from '../src';
import { applyProxy } from '../src/utils';
import { startServer, TestServer } from './server';

/** A host name only the SOCKS server below resolves, as a remote resolver would. */
const REMOTE_ONLY = 'yareq-socks.invalid';

interface SocksServer {
  url(scheme: string, credentials?: string): string;
  /** The destinations clients asked for, as sent: `name:port` or `ip:port`. */
  connects: string[];
  close(): Promise<void>;
}

/** A minimal SOCKS4/5 server (CONNECT; optional SOCKS5 user/pass auth). */
async function startSocks(login?: { user: string; pass: string }): Promise<SocksServer> {
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handle(socket, login, connects).catch(() => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (scheme, credentials) => `${scheme}://${credentials ? `${credentials}@` : ''}127.0.0.1:${port}`,
    connects,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(() => resolve()));
    }
  };
}

async function handle(socket: Socket, login: { user: string; pass: string } | undefined, connects: string[]) {
  let buffer = Buffer.alloc(0);
  let waiting: (() => void) | undefined;
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    waiting?.();
  };
  socket.on('data', onData);
  const read = async (n: number) => {
    while (buffer.length < n) await new Promise<void>(resolve => (waiting = resolve));
    const out = buffer.subarray(0, n);
    buffer = buffer.subarray(n);
    return out;
  };

  const [version, methods] = await read(2);
  let host: string;
  let port: number;
  if (version === 4) {
    const address = await read(6);
    port = address.readUInt16BE(0);
    const ip = [...address.subarray(2)];
    const readString = async () => {
      const bytes: number[] = [];
      let byte: number;
      while ((byte = (await read(1))[0]) !== 0) bytes.push(byte);
      return Buffer.from(bytes).toString();
    };
    await readString(); // user ID
    host = ip.slice(0, 3).every(byte => byte === 0) && ip[3] !== 0
      ? await readString()
      : ip.join('.');
  } else {
    const offered = [...(await read(methods))];
    if (login) {
      if (!offered.includes(0x02)) return void socket.end(Buffer.from([5, 0xff]));
      socket.write(Buffer.from([5, 0x02]));
      const [, userLength] = await read(2);
      const user = (await read(userLength)).toString();
      const [passLength] = await read(1);
      const pass = (await read(passLength)).toString();
      const ok = user === login.user && pass === login.pass;
      socket.write(Buffer.from([1, ok ? 0 : 1]));
      if (!ok) return void socket.end();
    } else {
      socket.write(Buffer.from([5, 0]));
    }

    const [, , , type] = await read(4);
    if (type === 1) host = [...(await read(4))].join('.');
    else if (type === 3) host = (await read((await read(1))[0])).toString();
    else throw new Error(`address type ${type}`);
    port = (await read(2)).readUInt16BE(0);
  }
  connects.push(`${host}:${port}`);

  const upstream = connect(port, host === REMOTE_ONLY ? '127.0.0.1' : host, () => {
    socket.write(Buffer.from(version === 4
      ? [0, 90, 0, 0, 0, 0, 0, 0]
      : [5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    socket.off('data', onData);
    if (buffer.length) upstream.write(buffer);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.once('close', () => upstream.destroy());
}

let target: TestServer;
let targetPort: string;

beforeAll(async () => {
  target = await startServer();
  targetPort = new URL(target.baseUrl).port;
});

test.each(['socks4', 'socks4a'])('%s tunnels HTTP with the expected DNS behavior', async scheme => {
  const socks = await startSocks();
  try {
    const host = scheme === 'socks4a' ? REMOTE_ONLY : '127.0.0.1';
    const res = await request(`http://${host}:${targetPort}/`, { proxy: socks.url(scheme) });
    expect(res.statusCode).toBe(200);
    expect(socks.connects).toEqual([`${host}:${targetPort}`]);
    if (scheme === 'socks4') {
      await expect(request(`http://${REMOTE_ONLY}:${targetPort}/`, {
        proxy: socks.url(scheme), timeout: 1000
      })).rejects.toThrow();
      expect(socks.connects).toHaveLength(1);
    }
  } finally {
    await socks.close();
  }
});

// Test-only certificate and key. Trust only this certificate for these requests.
const tlsCertificate = readFileSync(join(__dirname, 'fixtures/socks-cert.pem'));
const tlsKey = readFileSync(join(__dirname, 'fixtures/socks-key.pem'));

function httpsThroughSocks(url: URL, proxy: string, timeout: number, ca = tlsCertificate): Promise<string> {
  const options = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    ca
  };
  applyProxy(options, proxy, url, timeout);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(options, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.once('end', () => resolve(body));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.setTimeout(timeout, () => req.destroy(new RequestTimeoutError(timeout)));
    req.end();
  });
}

test('HTTPS through SOCKS validates the certificate and sends SNI', async () => {
  const socks = await startSocks();
  let servername: string | false | null | undefined;
  const secureTarget = createHttpsServer({ key: tlsKey, cert: tlsCertificate }, (req, res) => {
    if (req.url === '/timeout') setTimeout(() => res.end('late'), 200);
    else res.end('secure');
  });
  secureTarget.on('secureConnection', socket => { servername = socket.servername; });
  await new Promise<void>(resolve => secureTarget.listen(0, '127.0.0.1', resolve));
  const { port } = secureTarget.address() as AddressInfo;
  try {
    const url = new URL(`https://${REMOTE_ONLY}:${port}/`);
    await expect(httpsThroughSocks(url, socks.url('socks5h'), 1000)).resolves.toBe('secure');
    expect(servername).toBe(REMOTE_ONLY);
    expect(socks.connects).toEqual([`${REMOTE_ONLY}:${port}`]);

    await expect(httpsThroughSocks(new URL(`https://127.0.0.1:${port}/`), socks.url('socks5h'), 1000))
      .rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    await expect(httpsThroughSocks(new URL(`https://${REMOTE_ONLY}:${port}/timeout`), socks.url('socks5h'), 50))
      .rejects.toBeInstanceOf(RequestTimeoutError);
  } finally {
    await socks.close();
    await new Promise<void>(resolve => secureTarget.close(() => resolve()));
  }
});

test.each([
  { name: 'rejects a certificate for the proxy hostname', fixture: 'socks-localhost-cert.pem', valid: false },
  { name: 'accepts a certificate for the target IP', fixture: 'socks-ip-cert.pem', valid: true }
])('HTTPS to an IP through SOCKS $name', async ({ fixture, valid }) => {
  const certificate = readFileSync(join(__dirname, 'fixtures', fixture));
  const socks = await startSocks();
  const secureTarget = createHttpsServer({ key: tlsKey, cert: certificate }, (_req, res) => res.end('secure'));
  await new Promise<void>(resolve => secureTarget.listen(0, '127.0.0.1', resolve));
  const { port } = secureTarget.address() as AddressInfo;
  const proxy = new URL(socks.url('socks5h'));
  proxy.hostname = 'localhost';
  try {
    const response = httpsThroughSocks(new URL(`https://127.0.0.1:${port}/`), proxy.href, 1000, certificate);
    if (valid) {
      await expect(response).resolves.toBe('secure');
    } else {
      await expect(response).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    }
    expect(socks.connects).toEqual([`127.0.0.1:${port}`]);
  } finally {
    await socks.close();
    await new Promise<void>(resolve => secureTarget.close(() => resolve()));
  }
});

test('TLS negotiation through SOCKS honors the request timeout', async () => {
  const sockets = new Set<Socket>();
  const silentTarget = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>(resolve => silentTarget.listen(0, '127.0.0.1', resolve));
  const { port } = silentTarget.address() as AddressInfo;
  const socks = await startSocks();
  try {
    await expect(httpsThroughSocks(new URL(`https://${REMOTE_ONLY}:${port}/`), socks.url('socks5h'), 50))
      .rejects.toMatchObject({ name: 'RequestTimeoutError', code: 'ETIMEDOUT' });
    expect(socks.connects).toEqual([`${REMOTE_ONLY}:${port}`]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await socks.close();
    await new Promise<void>(resolve => silentTarget.close(() => resolve()));
  }
});

afterAll(async () => {
  await target.close();
});

test('socks5h sends the host name for the proxy to resolve', async () => {
  const socks = await startSocks();
  try {
    const res = await request(`http://${REMOTE_ONLY}:${targetPort}/`, { proxy: socks.url('socks5h') });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ url: string }>().url).toBe('/');
    expect(socks.connects).toEqual([`${REMOTE_ONLY}:${targetPort}`]);
  } finally {
    await socks.close();
  }
});

test('socks:// resolves through the proxy like socks5h', async () => {
  const socks = await startSocks();
  try {
    const res = await request(`http://${REMOTE_ONLY}:${targetPort}/`, { proxy: socks.url('socks') });
    expect(res.statusCode).toBe(200);
    expect(socks.connects).toEqual([`${REMOTE_ONLY}:${targetPort}`]);
  } finally {
    await socks.close();
  }
});

test('socks5 resolves the host name locally', async () => {
  const socks = await startSocks();
  try {
    await expect(
      request(`http://${REMOTE_ONLY}:${targetPort}/`, { proxy: socks.url('socks5'), timeout: 5000 })
    ).rejects.toThrow();
    expect(socks.connects).toEqual([]);

    const res = await request(`http://127.0.0.1:${targetPort}/`, { proxy: socks.url('socks5') });
    expect(res.statusCode).toBe(200);
    expect(socks.connects).toEqual([`127.0.0.1:${targetPort}`]);
  } finally {
    await socks.close();
  }
});

test('credentials in the proxy url authenticate', async () => {
  const socks = await startSocks({ user: 'crawler', pass: 's3cret' });
  try {
    const res = await request(`http://${REMOTE_ONLY}:${targetPort}/`, {
      proxy: socks.url('socks5h', 'crawler:s3cret')
    });
    expect(res.statusCode).toBe(200);

    await expect(
      request(`http://${REMOTE_ONLY}:${targetPort}/`, {
        proxy: socks.url('socks5h', 'crawler:wrong'),
        timeout: 5000
      })
    ).rejects.toThrow();
    expect(socks.connects).toHaveLength(1);
  } finally {
    await socks.close();
  }
});

test('an unreachable proxy rejects the request', async () => {
  const socks = await startSocks();
  const url = socks.url('socks5h');
  await socks.close();
  await expect(request(`http://${REMOTE_ONLY}:${targetPort}/`, { proxy: url, timeout: 5000 })).rejects.toThrow();
});

test('a stalled SOCKS request rejects with RequestTimeoutError', async () => {
  const socks = await startSocks();
  try {
    const error = await request(`http://${REMOTE_ONLY}:${targetPort}/timeout`, {
      proxy: socks.url('socks5h'),
      timeout: 50
    }).catch(error => error);

    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error.code).toBe('ETIMEDOUT');
    expect(socks.connects).toEqual([`${REMOTE_ONLY}:${targetPort}`]);
  } finally {
    await socks.close();
  }
});

test.each(['http', 'https'])('%s SOCKS negotiation honors the request timeout', async protocol => {
  const sockets = new Set<Socket>();
  const silentProxy = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>(resolve => silentProxy.listen(0, '127.0.0.1', resolve));
  const { port } = silentProxy.address() as AddressInfo;
  const controller = new AbortController();
  // Bound the test if negotiation incorrectly falls back to the agent's 30s default.
  const watchdog = setTimeout(() => controller.abort(), 1000);
  try {
    const error = await request(`${protocol}://${REMOTE_ONLY}/`, {
      proxy: `socks5h://127.0.0.1:${port}`,
      timeout: 50,
      signal: controller.signal
    }).catch(error => error);

    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error.code).toBe('ETIMEDOUT');
    expect(error.message).toContain('50ms');
  } finally {
    clearTimeout(watchdog);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => silentProxy.close(() => resolve()));
  }
});
