import { request, Response, WithUrl } from '../src';
import { readFile, unlink, readFileSync } from 'fs';
import * as zlib from 'zlib';

const TEST_URL = 'https://testfront.net';

interface File {
  res: any;
  buf: Buffer;
}

test('save #0', async () => {
  const url = { id: 1, url: `${TEST_URL}/redirect` };
  const res = await request(url, { followLocation: true });
  const path = getPath();
  await res.save(path, { compress: false });
  const out = await Response.load(path);
  expect(out.contentMD5).toBe(res.contentMD5);
  expect(out.contentMD5.length).toBe(32);
  expect(/text/.test(out.contentType)).toBe(true);
  expect((out.url as WithUrl).id).toBe(1);
  await remove(path);
}, 10000);

test('save #1', async () => {
  const res = await request(`${TEST_URL}/test/gzip`);
  const path = getPath();
  await res.save(path, { compress: false });
  const out = await load(path);
  expect(out.res._encoding).toBe(null);
  const echo = await Response.load(path);
  expect(echo.body.toString()).toBe('gzip');
  await remove(path);
});

test('save #2', async () => {
  const res = await request(`${TEST_URL}/test/gzip`);
  const path = getPath();
  await res.save(path, { compress: true });
  const out = await load(path);
  expect(out.res._encoding).toBe('gzip');
  const echo = await Response.load(path);
  expect(echo.body.toString()).toBe('gzip');
  await remove(path);
});

test('save #3', async () => {
  const res = await request(`${TEST_URL}/test/binary`);
  const path = getPath();
  await res.save(path, { compress: true });
  const out = await load(path);
  expect(out.res._encoding).toBe(null);
  const echo = await Response.load(path);
  expect(echo.body[0]).toBe(1);
  expect(echo.body[1]).toBe(2);
  expect(echo.body[2]).toBe(3);
  await remove(path);
});

test('save #4', async () => {
  const res = await request(TEST_URL);
  const path = getPath();
  await res.save(path, { bodyOnly: true, compress: false });
  const json = JSON.parse(readFileSync(path).toString());
  expect(json.address).toBe(res.json().address);
  await remove(path);
});

test('save #5', async done => {
  const res = await request(TEST_URL);
  const path = getPath();
  await res.save(path, { bodyOnly: true, compress: true });
  zlib.gunzip(readFileSync(path), (err, buf) => {
    if (err) throw err;
    const json = JSON.parse(buf.toString());
    expect(typeof json.address).toBe('string');
    remove(path).then(() => done());
  });
});

test('save #6', async () => {
  const res = await request(TEST_URL);
  const path = getPath();
  await res.save(path);
  const out = await Response.load(path);
  const d1 = <Date>res.fetchEnd;
  const d2 = <Date>out.fetchEnd;
  expect(d1.getTime()).toBe(d2.getTime());
  await remove(path);
});

async function load(path: string): Promise<File> {
  return new Promise((resolve, reject) => {
    readFile(path, (err, data) => {
      if (err) reject(err);
      else {
        const index = data.indexOf(0x0a),
          res = JSON.parse(data.slice(0, index).toString()),
          buf = data.slice(index + 1);
        resolve({ res, buf });
      }
    });
  });
}

function getPath() {
  const rand = Math.random()
    .toString(36)
    .substring(8);
  return `${rand}.tmp`;
}

function remove(path: string) {
  return new Promise(resolve => {
    unlink(path, err => {
      if (err) throw err;
      resolve();
    });
  });
}
