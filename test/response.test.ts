import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { request, Response } from '../src';
import { startServer, TestServer } from './server';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer();
  dir = await mkdtemp(join(tmpdir(), 'yareq-'));
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test('exposes response helpers', async () => {
  const res = await request(`${server.baseUrl}/`);

  expect(res.ok).toBe(true);
  expect(res.header('content-type')).toBe('application/json');
  expect(res.contentLength).toBeGreaterThan(0);
  expect(res.contentMD5).toHaveLength(32);
  expect(res.fetchDuration).toBeGreaterThanOrEqual(0);
  expect(res.json<{ method: string }>().method).toBe('GET');
});

test('saves and loads full response files', async () => {
  const res = await request(`${server.baseUrl}/redirect`, {
    redirect: 'follow'
  });
  const path = join(dir, 'response.bin');

  await res.save(path);
  const loaded = await Response.load(path);

  expect(loaded.text()).toBe('info');
  expect(loaded.contentMD5).toBe(res.contentMD5);
  expect(loaded.url).toBe(`${server.baseUrl}/info`);
  expect(loaded.requestUrl).toBe(`${server.baseUrl}/redirect`);
  expect(loaded.redirects).toEqual([`${server.baseUrl}/redirect`]);
  expect(loaded.fetchEnd.getTime()).toBe(res.fetchEnd.getTime());
});

test('compresses saved text responses', async () => {
  const res = await request(`${server.baseUrl}/info`);
  const path = join(dir, 'compressed.bin');

  await res.save(path, { compress: true });
  const file = await readFile(path);
  const index = file.indexOf(0x0a);
  const metadata = JSON.parse(file.slice(0, index).toString());
  const compressedBody = file.slice(index + 1);
  const loaded = await Response.load(path);

  expect(metadata._encoding).toBe('gzip');
  expect(gunzipSync(compressedBody).toString()).toBe('info');
  expect(loaded.text()).toBe('info');
});

test('does not compress binary responses', async () => {
  const res = await request(`${server.baseUrl}/binary`);
  const path = join(dir, 'binary.bin');

  await res.save(path, { compress: true });
  const file = await readFile(path);
  const index = file.indexOf(0x0a);
  const metadata = JSON.parse(file.slice(0, index).toString());
  const loaded = await Response.load(path);

  expect(metadata._encoding).toBe(null);
  expect([...loaded.body]).toEqual([1, 2, 3]);
});

test('can save response bodies only', async () => {
  const res = await request(`${server.baseUrl}/info`);
  const path = join(dir, 'body.txt');

  await res.save(path, { bodyOnly: true });

  expect((await readFile(path)).toString()).toBe('info');
});

test('can save streaming response bodies only', async () => {
  const res = await request(`${server.baseUrl}/large`, {
    responseType: 'stream'
  });
  const path = join(dir, 'stream-body.bin');

  await res.save(path, { bodyOnly: true });

  expect((await readFile(path)).length).toBe(128 * 1024);
});

test('rejects invalid saved response files', async () => {
  const path = join(dir, 'invalid.bin');
  await writeFile(path, 'invalid');

  await expect(Response.load(path)).rejects.toThrow(
    'metadata delimiter not found'
  );
});
