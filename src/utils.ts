import {
  Agent as HttpAgent,
  OutgoingHttpHeaders,
  RequestOptions as NodeRequestOptions
} from 'http';
import { PassThrough, Readable, Transform } from 'stream';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { HttpsAgent } from './https-agent';

const socks = require('socks-wrapper') as {
  HttpAgent: new (port: string | number, host: string) => HttpAgent;
  HttpsAgent: new (port: string | number, host: string) => HttpAgent;
};

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = zlib.brotliDecompress
  ? promisify(zlib.brotliDecompress)
  : undefined;

export type RequestUrl = string | URL;
export type HeaderValue = string | number | readonly string[];
export type HeaderEntries = Iterable<readonly [string, HeaderValue | undefined]>;
export type HeadersInput = OutgoingHttpHeaders | HeaderEntries;

export function rewriteUrl(url: string): string {
  const hasExplicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(url);
  const hasSchemeLikePrefix = /^[a-z][a-z\d+.-]*:/i.test(url);

  if (hasExplicitScheme || (hasSchemeLikePrefix && !looksLikeHostPort(url))) {
    return url;
  }

  return url.startsWith('//') ? `http:${url}` : `http://${url}`;
}

export function parseUrl(url: RequestUrl): URL {
  return url instanceof URL ? new URL(url.href) : new URL(rewriteUrl(url));
}

export function normalizeHeaders(headers?: HeadersInput): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};

  if (!headers) {
    return result;
  }

  if (isHeaderEntries(headers)) {
    for (const [key, value] of headers) {
      if (value !== undefined) {
        result[key] = value as string | number | string[];
      }
    }
    return result;
  }

  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

export function getHeader(
  headers: OutgoingHttpHeaders,
  key: string
): string | undefined {
  return getHeaderValues(headers, key)[0];
}

export function getHeaderValues(
  headers: OutgoingHttpHeaders,
  key: string
): string[] {
  const value = headers[findHeaderKey(headers, key) || key.toLowerCase()];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

export function hasHeader(headers: OutgoingHttpHeaders, key: string): boolean {
  return findHeaderKey(headers, key) !== undefined;
}

export function setHeader(
  headers: OutgoingHttpHeaders,
  key: string,
  value: HeaderValue
): void {
  const existing = findHeaderKey(headers, key);
  if (existing && existing !== key) {
    delete headers[existing];
  }
  headers[key] = value as string | number | string[];
}

export function setHeaderIfMissing(
  headers: OutgoingHttpHeaders,
  key: string,
  value: HeaderValue
): void {
  if (!hasHeader(headers, key)) {
    setHeader(headers, key, value);
  }
}

export async function inflateBody(
  content: Buffer,
  encoding: string
): Promise<Buffer> {
  const normalized = encoding.toLowerCase();

  if (normalized.includes('gzip')) {
    return gunzip(content);
  }

  if (normalized.includes('br') && brotliDecompress) {
    return brotliDecompress(content);
  }

  if (normalized.includes('deflate')) {
    try {
      return await inflate(content);
    } catch (error) {
      return inflateRaw(content);
    }
  }

  return content;
}

export function inflateStream(stream: Readable, encoding: string): Readable {
  const normalized = encoding.toLowerCase();

  if (normalized.includes('gzip')) {
    return pipeThrough(stream, zlib.createUnzip());
  }

  if (normalized.includes('deflate')) {
    return inflateDeflateStream(stream);
  }

  if (normalized.includes('br') && zlib.createBrotliDecompress) {
    return pipeThrough(stream, zlib.createBrotliDecompress());
  }

  return stream;
}

function pipeThrough(source: Readable, decompressor: Transform): Readable {
  source.once('error', error => decompressor.destroy(error));
  return source.pipe(decompressor);
}

function inflateDeflateStream(source: Readable): Readable {
  // `Content-Encoding: deflate` may be a zlib stream (RFC 1950) or a raw
  // deflate stream (RFC 1951). Pick the decoder from the first chunk's header,
  // then pipe so that consumer backpressure is preserved.
  const output = new PassThrough();
  let started = false;

  const failOutput = (error: Error) => output.destroy(error);
  source.once('error', failOutput);
  source.once('end', () => {
    if (!started) {
      output.end();
    }
  });

  source.once('data', firstChunk => {
    started = true;
    source.pause();
    source.removeListener('error', failOutput);

    const head = Buffer.isBuffer(firstChunk) ? firstChunk : Buffer.from(firstChunk);
    const inflater = isZlibHeader(head)
      ? zlib.createInflate()
      : zlib.createInflateRaw();

    source.once('error', error => inflater.destroy(error));
    inflater.once('error', failOutput);

    inflater.write(head);
    source.pipe(inflater).pipe(output);
    source.resume();
  });

  return output;
}

function isZlibHeader(head: Buffer): boolean {
  return (
    head.length >= 2 &&
    (head[0] & 0x0f) === 0x08 &&
    (((head[0] << 8) | head[1]) % 31) === 0
  );
}

export function isReadable(value: unknown): value is Readable {
  return value instanceof Readable;
}

export function applyProxy(
  request: NodeRequestOptions,
  proxyUrl: string | URL,
  targetUrl: URL,
  timeout: number
): void {
  const proxy = parseUrl(proxyUrl);

  if (/^socks/.test(proxy.protocol)) {
    const Agent =
      request.protocol === 'http:' ? socks.HttpAgent : socks.HttpsAgent;
    request.agent = new Agent(proxy.port || defaultPort(proxy), proxy.hostname);
    return;
  }

  if (targetUrl.protocol === 'http:') {
    request.protocol = proxy.protocol;
    request.hostname = proxy.hostname;
    request.port = proxy.port || defaultPort(proxy);
    request.path = targetUrl.href;
    return;
  }

  request.port = request.port || defaultPort(targetUrl);
  request.agent = new HttpsAgent({
    proxy,
    servername: targetUrl.hostname,
    timeout
  });
}

function findHeaderKey(
  headers: OutgoingHttpHeaders,
  key: string
): string | undefined {
  const normalized = key.toLowerCase();
  return Object.keys(headers).find(name => name.toLowerCase() === normalized);
}

function isHeaderEntries(headers: HeadersInput): headers is HeaderEntries {
  return (
    typeof (headers as HeaderEntries)[Symbol.iterator] === 'function' &&
    !Array.isArray((headers as OutgoingHttpHeaders).setCookie)
  );
}

function defaultPort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === 'https:' ? '443' : '80';
}

function looksLikeHostPort(url: string): boolean {
  return /^[^/:?#]+:\d+(?:[/?#]|$)/.test(url);
}
