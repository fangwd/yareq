import { Header, setHeader } from '../src/utils';

test('setHeader', () => {
  let headers: Header[];

  headers = [['accept-encoding', 'gzip']];
  setHeader(headers, 'Cookie', 'id=1');
  expect(headers.length).toBe(2);
  expect(headers[1][0]).toBe('Cookie');

  headers = [['accept-encoding', 'gzip'], ['User-Agent', 'Mozilla/5.0']];
  setHeader(headers, 'cookie', 'id=1');
  expect(headers.length).toBe(3);
  expect(headers[1][0]).toBe('cookie');

  headers = [];
  setHeader(headers, 'Cookie', 'id=1');
  expect(headers.length).toBe(1);
  expect(headers[0][0]).toBe('Cookie');

  headers = [['User-Agent', 'Mozilla/5.0']];
  setHeader(headers, 'Cookie', 'id=1');
  expect(headers.length).toBe(2);
  expect(headers[0][0]).toBe('Cookie');
});
