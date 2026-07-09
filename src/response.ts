import { createWriteStream } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { IncomingHttpHeaders, OutgoingHttpHeaders } from 'http';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import {
  createGzip,
  gzip as gzipCallback,
  gunzip as gunzipCallback
} from 'zlib';
import { getHeader, getHeaderValues } from './utils';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export interface SaveOptions {
  compress?: boolean;
  bodyOnly?: boolean;
}

export interface ResponseInit {
  url: string;
  requestUrl: string;
  statusCode: number;
  headers: IncomingHttpHeaders | OutgoingHttpHeaders;
  httpVersion: string;
  body: Buffer;
  fetchStart: Date;
  fetchEnd: Date;
  redirects?: string[];
}

export interface StreamResponseInit extends Omit<ResponseInit, 'body'> {
  body: Readable;
}

interface StoredResponse {
  url: string;
  requestUrl: string;
  statusCode: number;
  headers: IncomingHttpHeaders;
  httpVersion: string;
  fetchStart: string;
  fetchEnd: string;
  redirects: string[];
  _encoding: 'gzip' | null;
}

export class ResponseMetadata {
  readonly url: string;
  readonly requestUrl: string;
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly httpVersion: string;
  readonly fetchStart: Date;
  readonly fetchEnd: Date;
  readonly redirects: string[];

  constructor(init: Omit<ResponseInit, 'body'>) {
    this.url = init.url;
    this.requestUrl = init.requestUrl;
    this.statusCode = init.statusCode;
    this.headers = normalizeResponseHeaders(init.headers);
    this.httpVersion = init.httpVersion;
    this.fetchStart = init.fetchStart;
    this.fetchEnd = init.fetchEnd;
    this.redirects = init.redirects || [];
  }

  get ok(): boolean {
    return this.statusCode >= 200 && this.statusCode <= 299;
  }

  get redirected(): boolean {
    return this.redirects.length > 0;
  }

  get contentEncoding(): string {
    return this.header('content-encoding') || '';
  }

  get contentType(): string {
    return this.header('content-type') || '';
  }

  get fetchDuration(): number {
    return this.fetchEnd.getTime() - this.fetchStart.getTime();
  }

  header(name: string): string | undefined {
    return getHeader(this.headers, name);
  }

  headerValues(name: string): string[] {
    return getHeaderValues(this.headers, name);
  }
}

export class Response extends ResponseMetadata {
  readonly body: Buffer;

  constructor(init: ResponseInit) {
    super(init);
    this.body = init.body;
  }

  get contentMD5(): string {
    return createHash('md5').update(this.body).digest('hex');
  }

  get contentLength(): number {
    return this.body.length;
  }

  text(encoding: BufferEncoding = 'utf8'): string {
    return this.body.toString(encoding);
  }

  json<T = unknown>(): T {
    return JSON.parse(this.text()) as T;
  }

  async save(path: string, options: SaveOptions = {}): Promise<this> {
    const compress =
      !!options.compress && /\b(text|json|xml|javascript)\b/i.test(this.contentType);
    const body = compress ? await gzip(this.body) : this.body;

    if (options.bodyOnly) {
      await writeFile(path, body);
      return this;
    }

    const metadata: StoredResponse = {
      url: this.url,
      requestUrl: this.requestUrl,
      statusCode: this.statusCode,
      headers: this.headers,
      httpVersion: this.httpVersion,
      fetchStart: this.fetchStart.toISOString(),
      fetchEnd: this.fetchEnd.toISOString(),
      redirects: this.redirects,
      _encoding: compress ? 'gzip' : null
    };
    const head = Buffer.from(JSON.stringify(metadata));
    await writeFile(path, Buffer.concat([head, Buffer.from([0x0a]), body]));
    return this;
  }

  static async load(path: string): Promise<Response> {
    const data = await readFile(path);
    const index = data.indexOf(0x0a);

    if (index < 0) {
      throw new Error('Invalid saved response: metadata delimiter not found');
    }

    const stored = JSON.parse(data.slice(0, index).toString()) as StoredResponse;
    const rawBody = data.slice(index + 1);
    const body =
      stored._encoding === 'gzip' && rawBody.length > 0
        ? await gunzip(rawBody)
        : rawBody;

    return new Response({
      url: stored.url,
      requestUrl: stored.requestUrl,
      statusCode: stored.statusCode,
      headers: stored.headers,
      httpVersion: stored.httpVersion,
      body,
      fetchStart: new Date(stored.fetchStart),
      fetchEnd: new Date(stored.fetchEnd),
      redirects: stored.redirects
    });
  }
}

export class StreamResponse extends ResponseMetadata {
  readonly body: Readable;

  constructor(init: StreamResponseInit) {
    super(init);
    this.body = init.body;
  }

  get contentLength(): number | undefined {
    if (this.contentEncoding) {
      return undefined;
    }

    const value = this.header('content-length');
    if (!value) {
      return undefined;
    }
    const length = Number(value);
    return Number.isFinite(length) ? length : undefined;
  }

  async buffer(): Promise<Buffer> {
    return readStream(this.body);
  }

  async text(encoding: BufferEncoding = 'utf8'): Promise<string> {
    return (await this.buffer()).toString(encoding);
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async toResponse(): Promise<Response> {
    return new Response({
      url: this.url,
      requestUrl: this.requestUrl,
      statusCode: this.statusCode,
      headers: this.headers,
      httpVersion: this.httpVersion,
      body: await this.buffer(),
      fetchStart: this.fetchStart,
      fetchEnd: this.fetchEnd,
      redirects: this.redirects
    });
  }

  async save(path: string, options: SaveOptions = {}): Promise<this> {
    const compress =
      !!options.compress && /\b(text|json|xml|javascript)\b/i.test(this.contentType);
    const output = createWriteStream(path);

    if (options.bodyOnly) {
      await pipeline(this.body, ...(compress ? [createGzip()] : []), output);
      return this;
    }

    const metadata = buildStoredResponse(this, compress);
    output.write(Buffer.concat([
      Buffer.from(JSON.stringify(metadata)),
      Buffer.from([0x0a])
    ]));
    await pipeline(this.body, ...(compress ? [createGzip()] : []), output);
    return this;
  }
}

function normalizeResponseHeaders(
  headers: IncomingHttpHeaders | OutgoingHttpHeaders
): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (value !== undefined) {
      result[key.toLowerCase()] = value as string | string[];
    }
  }
  return result;
}

function buildStoredResponse(
  response: ResponseMetadata,
  compressed: boolean
): StoredResponse {
  return {
    url: response.url,
    requestUrl: response.requestUrl,
    statusCode: response.statusCode,
    headers: response.headers,
    httpVersion: response.httpVersion,
    fetchStart: response.fetchStart.toISOString(),
    fetchEnd: response.fetchEnd.toISOString(),
    redirects: response.redirects,
    _encoding: compressed ? 'gzip' : null
  };
}

function readStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}
