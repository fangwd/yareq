import {
  file,
  multipart,
  request,
  RequestTimeoutError,
  RetryContext,
  TooManyRedirectsError
} from '../src';
import { startServer, TestServer } from './server';
import { Readable } from 'stream';
import * as tough from 'tough-cookie';

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

test('performs a get request', async () => {
  const res = await request(server.baseUrl);
  const body = res.json<{ method: string; headers: Record<string, string> }>();

  expect(res.ok).toBe(true);
  expect(body.method).toBe('GET');
  expect(body.headers['user-agent']).toMatch(/^Yareq\/\d+\.\d+\.\d+$/);
});

test('inflates gzip and deflate responses by default', async () => {
  const gzip = await request(`${server.baseUrl}/gzip`);
  const deflate = await request(`${server.baseUrl}/deflate`);
  const deflateRaw = await request(`${server.baseUrl}/deflate-raw`);

  expect(gzip.text()).toBe('gzip');
  expect(deflate.text()).toBe('deflate');
  expect(deflateRaw.text()).toBe('deflate raw');
});

test('can return compressed response bodies', async () => {
  const res = await request(`${server.baseUrl}/gzip`, { decompress: false });

  expect(res.text()).not.toBe('gzip');
  expect(res.contentEncoding).toBe('gzip');
});

test('posts raw bodies', async () => {
  const res = await request(`${server.baseUrl}/echo`, { body: 'hello' });

  expect(res.text()).toBe('hello');
});

test('posts json bodies', async () => {
  const res = await request(`${server.baseUrl}/echo`, {
    json: { hello: 'world' }
  });

  expect(res.contentType).toBe('application/json');
  expect(res.json<{ hello: string }>().hello).toBe('world');
});

test('supports URLSearchParams request bodies', async () => {
  const res = await request(`${server.baseUrl}/echo`, {
    body: new URLSearchParams({ a: '1', b: '2' })
  });

  expect(res.contentType).toBe('application/x-www-form-urlencoded');
  expect(res.text()).toBe('a=1&b=2');
});

test('returns redirects in manual mode', async () => {
  const res = await request(`${server.baseUrl}/redirect`);

  expect(res.statusCode).toBe(301);
  expect(res.header('location')).toBe('/info');
  expect(res.redirected).toBe(false);
});

test('follows redirects when requested', async () => {
  const res = await request(`${server.baseUrl}/redirect`, {
    redirect: 'follow'
  });

  expect(res.statusCode).toBe(200);
  expect(res.text()).toBe('info');
  expect(res.url).toBe(`${server.baseUrl}/info`);
  expect(res.requestUrl).toBe(`${server.baseUrl}/redirect`);
  expect(res.redirects).toEqual([`${server.baseUrl}/redirect`]);
  expect(res.redirected).toBe(true);
});

test('limits redirects without double-counting', async () => {
  await expect(
    request(`${server.baseUrl}/loop`, {
      redirect: 'follow',
      maxRedirects: 2
    })
  ).rejects.toBeInstanceOf(TooManyRedirectsError);
});

test('switches 303 redirects to GET', async () => {
  const res = await request(`${server.baseUrl}/see-other`, {
    method: 'POST',
    body: 'hello',
    redirect: 'follow'
  });

  expect(res.text()).toBe('GET');
});

test('times out requests', async () => {
  await expect(
    request(`${server.baseUrl}/timeout`, { timeout: 20 })
  ).rejects.toBeInstanceOf(RequestTimeoutError);
});

test('supports async cookie hooks', async () => {
  const jar = new tough.CookieJar();
  const options = {
    setCookie: (cookie: string, url: URL) => {
      jar.setCookieSync(cookie, url.href);
    },
    getCookie: (url: URL) => jar.getCookieStringSync(url.href)
  };

  await request(`${server.baseUrl}/cookie`, options);
  const res = await request(`${server.baseUrl}/cookie`, options);

  expect(res.json<{ cookie: string }>().cookie).toBe('id=1');
});

test('exposes all set-cookie header values', async () => {
  const res = await request(`${server.baseUrl}/multi-cookie`);

  expect(res.header('set-cookie')).toBe('a=1; Path=/');
  expect(res.headerValues('set-cookie')).toEqual([
    'a=1; Path=/',
    'b=2; Path=/'
  ]);
});

test('sets basic authorization', async () => {
  const res = await request(`${server.baseUrl}/basic`, {
    authorization: {
      type: 'basic',
      username: 'user',
      password: 'pass'
    }
  });

  expect(res.json<{ authorization: string }>().authorization).toBe(
    'Basic dXNlcjpwYXNz'
  );
});

test('keeps authorization across same-origin redirects', async () => {
  const res = await request(
    `${server.baseUrl}/redirect-to?url=${encodeURIComponent('/basic')}`,
    {
      redirect: 'follow',
      authorization: { type: 'basic', username: 'user', password: 'pass' }
    }
  );

  expect(res.json<{ authorization: string }>().authorization).toBe(
    'Basic dXNlcjpwYXNz'
  );
});

test('drops authorization on cross-origin redirects', async () => {
  const other = await startServer();
  try {
    const res = await request(
      `${server.baseUrl}/redirect-to?url=${encodeURIComponent(
        `${other.baseUrl}/basic`
      )}`,
      {
        redirect: 'follow',
        authorization: { type: 'basic', username: 'user', password: 'pass' }
      }
    );

    expect(res.url).toBe(`${other.baseUrl}/basic`);
    expect(res.json<{ authorization: string | null }>().authorization).toBeNull();
  } finally {
    await other.close();
  }
});

test('returns streaming responses without buffering first', async () => {
  const res = await request(`${server.baseUrl}/large`, {
    responseType: 'stream'
  });
  let size = 0;

  for await (const chunk of res.body) {
    size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
  }

  expect(res.contentLength).toBe(128 * 1024);
  expect(size).toBe(128 * 1024);
});

test('can decompress streaming responses', async () => {
  const res = await request(`${server.baseUrl}/gzip`, {
    responseType: 'stream'
  });

  expect(await res.text()).toBe('gzip');
});

test('can decompress streaming raw deflate responses', async () => {
  const res = await request(`${server.baseUrl}/deflate-raw`, {
    responseType: 'stream'
  });

  expect(await res.text()).toBe('deflate raw');
});

test('follows redirects before returning a streaming response', async () => {
  const res = await request(`${server.baseUrl}/redirect`, {
    redirect: 'follow',
    responseType: 'stream'
  });

  expect(await res.text()).toBe('info');
  expect(res.url).toBe(`${server.baseUrl}/info`);
  expect(res.redirects).toEqual([`${server.baseUrl}/redirect`]);
});

test('retries configured status codes for safe methods', async () => {
  const res = await request(`${server.baseUrl}/retry-status?case=safe`, {
    retry: { retries: 2, delay: 0 }
  });

  expect(res.statusCode).toBe(200);
  expect(res.text()).toBe('ok');
  expect(res.header('x-attempt')).toBe('2');
});

test('does not retry unsafe methods by default', async () => {
  const res = await request(`${server.baseUrl}/retry-status?case=post`, {
    method: 'POST',
    body: 'hello',
    retry: { retries: 2, delay: 0 }
  });

  expect(res.statusCode).toBe(503);
  expect(res.header('x-attempt')).toBe('1');
});

test('retries unsafe methods when explicitly allowed and replayable', async () => {
  const res = await request(`${server.baseUrl}/retry-status?case=post-allowed`, {
    method: 'POST',
    body: 'hello',
    retry: { retries: 2, methods: ['POST'], delay: 0 }
  });

  expect(res.statusCode).toBe(200);
  expect(res.header('x-attempt')).toBe('2');
});

test('rejects retries for non-replayable request bodies', async () => {
  await expect(
    request(`${server.baseUrl}/retry-status?case=stream-body`, {
      method: 'PUT',
      body: Readable.from(['hello']),
      retry: { retries: 1, methods: ['PUT'], delay: 0 }
    })
  ).rejects.toThrow('non-replayable body');
});

test('retries transient request errors with backoff context', async () => {
  const contexts: RetryContext[] = [];
  const res = await request(`${server.baseUrl}/timeout-once?case=timeout`, {
    timeout: 20,
    retry: {
      retries: 1,
      delay: context => {
        contexts.push(context);
        return 0;
      }
    }
  });

  expect(res.text()).toBe('ok');
  expect(res.header('x-attempt')).toBe('2');
  expect(contexts).toHaveLength(1);
  expect(contexts[0].attempt).toBe(1);
  expect(contexts[0].error).toBeInstanceOf(RequestTimeoutError);
});

test('sends multipart form-data with known content length', async () => {
  const res = await request(`${server.baseUrl}/multipart`, {
    body: multipart({
      name: 'Ada',
      count: 1,
      upload: file(Buffer.from('hello'), 'hello.txt', 'text/plain')
    })
  });
  const body = res.json<{
    headers: Record<string, string>;
    body: string;
  }>();

  expect(body.headers['content-type']).toMatch(
    /^multipart\/form-data; boundary=yareq-/
  );
  expect(body.headers['content-length']).toBeDefined();
  expect(body.body).toContain('name="name"');
  expect(body.body).toContain('Ada');
  expect(body.body).toContain('filename="hello.txt"');
  expect(body.body).toContain('Content-Type: text/plain');
  expect(body.body).toContain('hello');
});

test('streams multipart form-data when a part is a stream', async () => {
  const res = await request(`${server.baseUrl}/multipart`, {
    body: multipart({
      upload: file(Readable.from(['streamed']), 'stream.txt', 'text/plain')
    })
  });
  const body = res.json<{
    headers: Record<string, string>;
    body: string;
  }>();

  expect(body.headers['content-type']).toMatch(
    /^multipart\/form-data; boundary=yareq-/
  );
  expect(body.headers['content-length']).toBeUndefined();
  expect(body.headers['transfer-encoding']).toBe('chunked');
  expect(body.body).toContain('filename="stream.txt"');
  expect(body.body).toContain('streamed');
});
