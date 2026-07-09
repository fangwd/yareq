import {
  IncomingMessage,
  OutgoingHttpHeaders,
  request as httpRequest,
  RequestOptions as NodeRequestOptions
} from 'http';
import { request as httpsRequest } from 'https';
import { Readable } from 'stream';
import { MultipartBody } from './multipart';
import { Response, StreamResponse } from './response';
import { RequestTimeoutError, TooManyRedirectsError } from './errors';
import {
  applyProxy,
  HeadersInput,
  inflateBody,
  inflateStream,
  isReadable,
  normalizeHeaders,
  parseUrl,
  RequestUrl,
  setHeader,
  setHeaderIfMissing
} from './utils';

const { version } = require('../package.json') as { version: string };

type MaybePromise<T> = T | Promise<T>;

export type { HeadersInput, RequestUrl };

export type RequestBody =
  | string
  | Buffer
  | Uint8Array
  | URLSearchParams
  | Readable
  | MultipartBody;

export interface BasicAuthorization {
  type: 'basic';
  username: string;
  password: string;
}

export type Authorization = BasicAuthorization | string;
export type RedirectMode = 'manual' | 'follow';
export type ResponseType = 'buffer' | 'stream';

export interface RetryContext {
  attempt: number;
  retries: number;
  method: string;
  url: string;
  statusCode?: number;
  error?: Error;
}

export interface RetryOptions {
  retries?: number;
  methods?: readonly string[];
  statusCodes?: readonly number[];
  errorCodes?: readonly string[];
  delay?: number | ((context: RetryContext) => number);
  maxDelay?: number;
  factor?: number;
  jitter?: boolean | number;
  respectRetryAfter?: boolean;
}

export interface RequestOptions {
  method?: string;
  headers?: HeadersInput;
  body?: RequestBody;
  json?: unknown;
  timeout?: number;
  redirect?: RedirectMode;
  maxRedirects?: number;
  proxy?: string | URL;
  decompress?: boolean;
  responseType?: ResponseType;
  retry?: number | RetryOptions;
  authorization?: Authorization;
  signal?: AbortSignal;
  getCookie?: (url: URL) => MaybePromise<string | number | undefined>;
  setCookie?: (cookie: string, url: URL) => MaybePromise<void>;
}

type SerializedRequestBody = string | Buffer | Readable;

interface SerializedBody {
  body?: SerializedRequestBody;
  headers: OutgoingHttpHeaders;
}

export function request(
  url: RequestUrl,
  options: RequestOptions & { responseType: 'stream' }
): Promise<StreamResponse>;
export function request(
  url: RequestUrl,
  options?: RequestOptions & { responseType?: 'buffer' }
): Promise<Response>;
export async function request(
  url: RequestUrl,
  options: RequestOptions = {}
): Promise<Response | StreamResponse> {
  const retry = normalizeRetry(options.retry);
  const initialUrl = parseUrl(url);
  const method = normalizeMethod(options);

  if (
    retry.retries > 0 &&
    retry.methods.includes(method) &&
    !canReplayBody(options.body)
  ) {
    throw new TypeError('Cannot retry a request with a non-replayable body');
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await requestOnce(initialUrl, options);
      const retryContext = retryContextForStatus(
        retry,
        attempt,
        method,
        initialUrl.href,
        response
      );

      if (!retryContext || !canRetryRequest(retry, method, options.body)) {
        return response;
      }

      discardResponse(response);
      await delayForRetry(retry, retryContext, response.header('retry-after'));
    } catch (error) {
      const retryContext = retryContextForError(
        retry,
        attempt,
        method,
        initialUrl.href,
        error
      );

      if (!retryContext || !canRetryRequest(retry, method, options.body)) {
        throw error;
      }

      await delayForRetry(retry, retryContext);
    }
  }
}

async function requestOnce(
  initialUrl: URL,
  options: RequestOptions
): Promise<Response | StreamResponse> {
  const fetchStart = new Date();
  const redirects: string[] = [];
  const maxRedirects = options.maxRedirects ?? 20;
  const timeout = options.timeout ?? 30000;
  let currentUrl = initialUrl;
  let method = normalizeMethod(options);
  let body = options.body;
  let json = options.json;

  while (true) {
    const serializedBody = serializeBody(body, json);
    const requestOptions = await buildRequestOptions(
      currentUrl,
      options,
      method,
      serializedBody,
      timeout,
      currentUrl.origin === initialUrl.origin
    );
    const { message } = await executeStream(
      requestOptions,
      serializedBody.body,
      timeout
    );
    await storeCookies(options, message.headers['set-cookie'], currentUrl);

    if (shouldFollowRedirectMessage(message, options.redirect)) {
      message.resume();

      if (redirects.length >= maxRedirects) {
        throw new TooManyRedirectsError(maxRedirects);
      }

      const location = headerToString(message.headers.location);
      redirects.push(currentUrl.href);
      currentUrl = new URL(location, currentUrl);

      const switchToGet = shouldSwitchRedirectToGet(
        message.statusCode || -1,
        method
      );
      if (switchToGet) {
        method = 'GET';
        body = undefined;
        json = undefined;
      } else if (!canReplayBody(body)) {
        throw new Error('Cannot follow a preserving redirect with a non-replayable body');
      }

      continue;
    }

    if (options.responseType === 'stream') {
      const stream =
        options.decompress === false
          ? message
          : inflateStream(
              message,
              headerToString(message.headers['content-encoding'])
            );
      return new StreamResponse({
        url: currentUrl.href,
        requestUrl: initialUrl.href,
        statusCode: message.statusCode || -1,
        headers: message.headers,
        httpVersion: message.httpVersion,
        body: stream,
        fetchStart,
        fetchEnd: new Date(),
        redirects: [...redirects]
      });
    }

    const responseBody = await readResponseBody(message);
    const decodedBody =
      options.decompress === false
        ? responseBody
        : await inflateBody(
            responseBody,
            headerToString(message.headers['content-encoding'])
          );

    return new Response({
      url: currentUrl.href,
      requestUrl: initialUrl.href,
      statusCode: message.statusCode || -1,
      headers: message.headers,
      httpVersion: message.httpVersion,
      body: decodedBody,
      fetchStart,
      fetchEnd: new Date(),
      redirects: [...redirects]
    });
  }
}

async function buildRequestOptions(
  url: URL,
  options: RequestOptions,
  method: string,
  serializedBody: SerializedBody,
  timeout: number,
  sendAuthorization: boolean
): Promise<NodeRequestOptions> {
  const headers = normalizeHeaders(options.headers);
  applyDefaultHeaders(headers, options);
  applyBodyHeaders(headers, serializedBody.headers);
  if (sendAuthorization) {
    applyAuthorization(headers, options.authorization);
  }
  await applyCookies(headers, options, url);

  const requestOptions: NodeRequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    timeout,
    signal: options.signal
  };

  if (url.username || url.password) {
    requestOptions.auth = `${decodeURIComponent(
      url.username
    )}:${decodeURIComponent(url.password)}`;
  }

  if (options.proxy) {
    applyProxy(requestOptions, options.proxy, url, timeout);
  }

  return requestOptions;
}

function applyDefaultHeaders(
  headers: OutgoingHttpHeaders,
  options: RequestOptions
): void {
  if (options.decompress !== false) {
    setHeaderIfMissing(headers, 'Accept-Encoding', 'gzip, deflate, br');
  }
  setHeaderIfMissing(headers, 'User-Agent', `Yareq/${version}`);
}

function applyBodyHeaders(
  headers: OutgoingHttpHeaders,
  bodyHeaders: OutgoingHttpHeaders
): void {
  for (const key of Object.keys(bodyHeaders)) {
    setHeaderIfMissing(headers, key, bodyHeaders[key] as string | number);
  }
}

function applyAuthorization(
  headers: OutgoingHttpHeaders,
  authorization?: Authorization
): void {
  if (!authorization) {
    return;
  }

  if (typeof authorization === 'string') {
    setHeader(headers, 'Authorization', authorization);
    return;
  }

  if (authorization.type !== 'basic') {
    throw new TypeError(`Unsupported authorization type: ${authorization.type}`);
  }

  const { username, password } = authorization;
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  setHeader(headers, 'Authorization', `Basic ${token}`);
}

async function applyCookies(
  headers: OutgoingHttpHeaders,
  options: RequestOptions,
  url: URL
): Promise<void> {
  if (!options.getCookie) {
    return;
  }

  const cookie = await options.getCookie(url);
  if (cookie) {
    setHeader(headers, 'Cookie', cookie);
  }
}

async function storeCookies(
  options: RequestOptions,
  cookies: string | string[] | undefined,
  url: URL
): Promise<void> {
  if (!cookies || !options.setCookie) {
    return;
  }

  const values = Array.isArray(cookies) ? cookies : [cookies];
  for (const cookie of values) {
    await options.setCookie(cookie, url);
  }
}

function serializeBody(body: RequestBody | undefined, json: unknown): SerializedBody {
  if (body !== undefined && json !== undefined) {
    throw new TypeError('Use either body or json, not both');
  }

  if (json !== undefined) {
    const content = Buffer.from(JSON.stringify(json));
    return {
      body: content,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': content.length
      }
    };
  }

  if (body === undefined) {
    return { headers: {} };
  }

  if (typeof body === 'string') {
    return {
      body,
      headers: {
        'Content-Length': Buffer.byteLength(body)
      }
    };
  }

  if (body instanceof URLSearchParams) {
    const content = Buffer.from(body.toString());
    return {
      body: content,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': content.length
      }
    };
  }

  if (body instanceof MultipartBody) {
    return {
      body: body.stream(),
      headers: body.headers
    };
  }

  if (Buffer.isBuffer(body)) {
    return {
      body,
      headers: {
        'Content-Length': body.length
      }
    };
  }

  if (body instanceof Uint8Array) {
    const content = Buffer.from(body);
    return {
      body: content,
      headers: {
        'Content-Length': content.length
      }
    };
  }

  if (isReadable(body)) {
    return { body, headers: {} };
  }

  throw new TypeError('Unsupported request body; use json for objects');
}

function executeStream(
  options: NodeRequestOptions,
  body: SerializedRequestBody | undefined,
  timeout: number
): Promise<{ message: IncomingMessage }> {
  const transport = getTransport(options.protocol);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const req = transport(options, message => {
      if (!settled) {
        settled = true;
        resolve({ message });
      }
      message.once('error', fail);
    });

    req.once('error', fail);
    req.setTimeout(timeout, () => {
      req.destroy(new RequestTimeoutError(timeout));
    });

    if (body === undefined) {
      req.end();
    } else if (isReadable(body)) {
      body.once('error', fail);
      body.pipe(req);
    } else {
      req.end(body);
    }
  });
}

async function readResponseBody(message: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function getTransport(protocol: string | null | undefined): typeof httpRequest {
  if (protocol === 'http:') {
    return httpRequest;
  }
  if (protocol === 'https:') {
    return httpsRequest;
  }
  throw new TypeError(`Unsupported protocol: ${protocol || 'unknown'}`);
}

function normalizeMethod(options: RequestOptions): string {
  return (
    options.method || (options.body !== undefined || options.json !== undefined ? 'POST' : 'GET')
  ).toUpperCase();
}

interface NormalizedRetryOptions {
  retries: number;
  methods: readonly string[];
  statusCodes: readonly number[];
  errorCodes: readonly string[];
  delay: number | ((context: RetryContext) => number);
  maxDelay: number;
  factor: number;
  jitter: boolean | number;
  respectRetryAfter: boolean;
}

const DEFAULT_RETRY_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;
const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504] as const;
const DEFAULT_RETRY_ERROR_CODES = [
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT'
] as const;

function shouldFollowRedirectMessage(
  message: IncomingMessage,
  redirect: RedirectMode | undefined
): boolean {
  if (redirect !== 'follow') {
    return false;
  }

  return (
    [301, 302, 303, 307, 308].includes(message.statusCode || -1) &&
    !!message.headers.location
  );
}

function shouldSwitchRedirectToGet(statusCode: number, method: string): boolean {
  return statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST');
}

function normalizeRetry(retry: number | RetryOptions | undefined): NormalizedRetryOptions {
  const options = typeof retry === 'number' ? { retries: retry } : retry || {};
  return {
    retries: Math.max(0, options.retries || 0),
    methods: (options.methods || DEFAULT_RETRY_METHODS).map(method =>
      method.toUpperCase()
    ),
    statusCodes: options.statusCodes || DEFAULT_RETRY_STATUS_CODES,
    errorCodes: options.errorCodes || DEFAULT_RETRY_ERROR_CODES,
    delay: options.delay ?? 100,
    maxDelay: options.maxDelay ?? 30000,
    factor: options.factor ?? 2,
    jitter: options.jitter ?? false,
    respectRetryAfter: options.respectRetryAfter ?? true
  };
}

function retryContextForStatus(
  retry: NormalizedRetryOptions,
  attempt: number,
  method: string,
  url: string,
  response: Response | StreamResponse
): RetryContext | undefined {
  if (
    attempt >= retry.retries ||
    !retry.statusCodes.includes(response.statusCode)
  ) {
    return undefined;
  }

  return {
    attempt: attempt + 1,
    retries: retry.retries,
    method,
    url,
    statusCode: response.statusCode
  };
}

function retryContextForError(
  retry: NormalizedRetryOptions,
  attempt: number,
  method: string,
  url: string,
  error: unknown
): RetryContext | undefined {
  if (attempt >= retry.retries || !isRetryableError(retry, error)) {
    return undefined;
  }

  return {
    attempt: attempt + 1,
    retries: retry.retries,
    method,
    url,
    error: error instanceof Error ? error : undefined
  };
}

function canRetryRequest(
  retry: NormalizedRetryOptions,
  method: string,
  body: RequestBody | undefined
): boolean {
  return retry.methods.includes(method.toUpperCase()) && canReplayBody(body);
}

function canReplayBody(body: RequestBody | undefined): boolean {
  if (body === undefined) {
    return true;
  }
  if (body instanceof MultipartBody) {
    return body.replayable;
  }
  return !isReadable(body);
}

function discardResponse(response: Response | StreamResponse): void {
  if (response instanceof StreamResponse) {
    response.body.resume();
  }
}

async function delayForRetry(
  retry: NormalizedRetryOptions,
  context: RetryContext,
  retryAfter?: string
): Promise<void> {
  const retryAfterDelay =
    retry.respectRetryAfter && retryAfter ? parseRetryAfter(retryAfter) : undefined;
  const computed =
    retryAfterDelay ??
    (typeof retry.delay === 'function'
      ? retry.delay(context)
      : retry.delay * Math.pow(retry.factor, context.attempt - 1));
  const capped = Math.min(Math.max(0, computed), retry.maxDelay);
  const jittered = applyJitter(capped, retry.jitter);

  if (jittered > 0) {
    await new Promise(resolve => setTimeout(resolve, jittered));
  }
}

function parseRetryAfter(value: string): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

function applyJitter(delay: number, jitter: boolean | number): number {
  if (!jitter || delay <= 0) {
    return delay;
  }

  const ratio = jitter === true ? 0.2 : Math.max(0, jitter);
  const delta = delay * ratio;
  return Math.round(delay - delta + Math.random() * delta * 2);
}

function isRetryableError(
  retry: NormalizedRetryOptions,
  error: unknown
): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && retry.errorCodes.includes(code);
}

function headerToString(header: string | string[] | undefined): string {
  return Array.isArray(header) ? header.join(', ') : header || '';
}
