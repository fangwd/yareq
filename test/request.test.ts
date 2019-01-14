import { request, Response } from '../src';
import * as tough from 'tough-cookie';

const HTTP_URL = 'http://testfront.net:8091';
const HTTPS_URL = 'https://testfront.net';

const SOCKS_PROXY = process.env.SOCKS_PROXY || 'socks4a://localhost:9050';
const HTTP_PROXY = process.env.HTTP_PROXY;
const HTTPS_PROXY = process.env.HTTPS_PROXY || HTTP_PROXY;

let ourIp: string;

beforeAll(async () => {
  const response = await request(HTTPS_URL);
  ourIp = JSON.parse(response.body.toString()).address;
});

test('get', async () => {
  const res = await request(HTTPS_URL);
  expect(res.statusCode).toBe(200);
});

test('inflate', async () => {
  const url = `${HTTPS_URL}/test/gzip`;
  const res = await request(url);
  expect(res.body.toString()).toBe('gzip');
  const res2 = await request(url, { inflate: false });
  expect(res2.body.toString()).not.toBe('gzip');
});

test('post', async () => {
  const url = `${HTTPS_URL}/echo`;
  const data = 'hello';
  const res = await request(url, { data });
  expect(res.body.toString()).toBe(data);
});

test('post - json', async () => {
  const url = `${HTTPS_URL}/echo`;
  const options = {
    headers: { 'content-type': 'application/json' },
    data: { hello: 'world' }
  };
  const res = await request(url, options);
  expect(res.headers['content-type']).toBe('application/json');
  expect(JSON.parse(res.body.toString()).hello).toBe('world');
});

test('redirect', async () => {
  const url = `${HTTPS_URL}/redirect`;
  const res = await request(url);
  expect(res.statusCode).toBe(301);
});

test('follow location', async () => {
  const url = `${HTTPS_URL}/redirect`;
  const res = await request(url, { followLocation: true });
  expect(res.statusCode).toBe(200);
  expect(res.body.toString()).toBe('info');
}, 10000);

test('max redirect', async () => {
  const url = `${HTTPS_URL}/redirect`;
  try {
    await request(url, { followLocation: true, maxRedirect: 2 });
  } catch (error) {
    expect(/^Too many/i.test(error.message)).toBe(true);
  }
});

test('timeout', async () => {
  const url = `${HTTPS_URL}/timeout`;
  try {
    await request(url, { timeout: 2000 });
  } catch (error) {
    expect(/^Timeout/i.test(error.message)).toBe(true);
  }
});

test('cookie', async () => {
  const jar = new tough.CookieJar();
  const options = {
    setCookie: (cookie: string, url: string) => jar.setCookieSync(cookie, url),
    getCookie: (url: string) => jar.getCookieStringSync(url)
  };
  await request(HTTPS_URL, options);
  const res = await request(HTTPS_URL, options);
  expect(!!JSON.parse(res.body.toString()).headers.cookie).toBe(true);
});

test('proxy (http)', async () => {
  const res = await request(HTTP_URL, { proxy: HTTP_PROXY });
  expect(getIp(res)).not.toBe(ourIp);
});

test('proxy (https)', async () => {
  const res = await request(HTTPS_URL, { proxy: HTTPS_PROXY });
  expect(getIp(res)).not.toBe(ourIp);
});

test('socks proxy (http)', async () => {
  const res = await request(HTTP_URL, { proxy: SOCKS_PROXY });
  expect(getIp(res)).not.toBe(ourIp);
}, 10000);

test('socks proxy (https)', async () => {
  const res = await request(HTTPS_URL, { proxy: SOCKS_PROXY });
  expect(getIp(res)).not.toBe(ourIp);
}, 10000);

function getIp(res: Response): string {
  return JSON.parse(res.body.toString()).address;
}
