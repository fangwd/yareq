import { OutgoingHttpHeaders } from 'http';
import {
  getHeader,
  getHeaderValues,
  normalizeHeaders,
  parseUrl,
  setHeader,
  setHeaderIfMissing
} from '../src/utils';

test('parseUrl adds http to host-only URLs', () => {
  expect(parseUrl('example.com/path').href).toBe('http://example.com/path');
  expect(parseUrl('//example.com/path').href).toBe('http://example.com/path');
  expect(parseUrl('localhost:3000/api').href).toBe(
    'http://localhost:3000/api'
  );
  expect(parseUrl('127.0.0.1:3000/api').href).toBe(
    'http://127.0.0.1:3000/api'
  );
});

test('normalizes header entries', () => {
  const headers = normalizeHeaders([
    ['Accept', 'application/json'],
    ['X-Count', 1],
    ['X-Skip', undefined]
  ]);

  expect(headers.Accept).toBe('application/json');
  expect(headers['X-Count']).toBe(1);
  expect(headers['X-Skip']).toBeUndefined();
});

test('sets headers case-insensitively', () => {
  const headers: OutgoingHttpHeaders = {
    'accept-encoding': 'gzip'
  };

  setHeader(headers, 'Accept-Encoding', 'br');
  setHeader(headers, 'Cookie', 'id=1');
  setHeaderIfMissing(headers, 'cookie', 'id=2');

  expect(headers['accept-encoding']).toBeUndefined();
  expect(headers['Accept-Encoding']).toBe('br');
  expect(getHeader(headers, 'accept-encoding')).toBe('br');
  expect(getHeader(headers, 'Cookie')).toBe('id=1');
});

test('gets all header values', () => {
  const headers: OutgoingHttpHeaders = {
    'set-cookie': ['a=1', 'b=2']
  };

  expect(getHeader(headers, 'Set-Cookie')).toBe('a=1');
  expect(getHeaderValues(headers, 'Set-Cookie')).toEqual(['a=1', 'b=2']);
  expect(getHeaderValues(headers, 'missing')).toEqual([]);
});
