# yareq

Yet another HTTP request library for Node.js.

A thin, promise-based wrapper around Node's built-in `http`/`https` modules with
first-class support for JSON, multipart forms, streaming, redirects, retries,
proxies (HTTP/HTTPS CONNECT/SOCKS), basic auth, and cookies — and one runtime
dependency, `socks-proxy-agent`, for SOCKS.

## Install

```sh
npm install yareq
```

Requires Node.js 18 or newer. Ships with TypeScript type definitions.

## Quick start

```js
const { request } = require('yareq');

async function main() {
  const response = await request('https://example.com/api/status');

  console.log(response.statusCode); // 200
  console.log(response.ok);         // true
  console.log(response.text());     // body as a string
}

main().catch(console.error);
```

ESM / TypeScript:

```ts
import { request } from 'yareq';

const response = await request('https://example.com/api/status');
```

By default a request is **buffered**: the full response body is read into memory
and returned as a [`Response`](#response). Pass `responseType: 'stream'` to get a
[`StreamResponse`](#streamresponse) instead (see [Streaming](#streaming-responses)).

## Table of contents

- [Making requests](#making-requests)
- [Request bodies](#request-bodies)
  - [JSON](#json)
  - [Raw bodies](#raw-bodies)
  - [Multipart forms](#multipart-forms)
- [Streaming responses](#streaming-responses)
- [Redirects](#redirects)
- [Retries](#retries)
- [Authorization](#authorization)
- [Cookies](#cookies)
- [Proxies](#proxies)
- [Timeouts and cancellation](#timeouts-and-cancellation)
- [Saving and loading responses](#saving-and-loading-responses)
- [API reference](#api-reference)

## Making requests

```js
const response = await request(url, options);
```

- **`url`** — a string or a `URL`. Bare hosts are assumed to be `http://`, so
  `example.com/path` becomes `http://example.com/path`, and
  `localhost:3000/api` becomes `http://localhost:3000/api`.
- **`options`** — see [`RequestOptions`](#requestoptions). All options are optional.

The HTTP method defaults to `GET`, or `POST` when a `body` or `json` is
provided. Set `method` explicitly to override.

```js
await request('https://example.com/api/items/1', { method: 'DELETE' });
```

## Request bodies

Provide exactly one of `json` or `body` — passing both throws a `TypeError`.

### JSON

`json` serializes any value with `JSON.stringify` and sets
`Content-Type: application/json`.

```js
const response = await request('https://example.com/api/messages', {
  json: { message: 'hello' }
});

console.log(response.json()); // parsed response body
```

### Raw bodies

`body` accepts a `string`, `Buffer`, `Uint8Array`, `URLSearchParams`, a readable
stream, or a [`MultipartBody`](#multipart-forms). Appropriate headers are set
automatically where possible.

```js
// Form-urlencoded — sets Content-Type: application/x-www-form-urlencoded
await request('https://example.com/form', {
  body: new URLSearchParams({ q: 'search' })
});

// Raw string or buffer — sets Content-Length
await request('https://example.com/echo', { body: 'hello' });

// A stream — sent with chunked transfer encoding
const { createReadStream } = require('fs');
await request('https://example.com/upload', {
  method: 'POST',
  body: createReadStream('data.bin')
});
```

Any header you set explicitly (e.g. a custom `Content-Type`) takes precedence
over the automatically derived ones.

### Multipart forms

Use `multipart()` to build a `multipart/form-data` body, and `file()` to attach
a file part with a filename and content type. Parts with known sizes produce a
`Content-Length`; if any part is a stream, the request is sent chunked.

```js
const { file, multipart, request } = require('yareq');
const { createReadStream } = require('fs');

await request('https://example.com/upload', {
  body: multipart({
    title: 'Report',
    tags: ['a', 'b'], // arrays expand into repeated fields
    attachment: file(
      createReadStream('report.pdf'),
      'report.pdf',
      'application/pdf'
    )
  })
});
```

Fields may be strings, numbers, booleans, `Buffer`, `Uint8Array`, or streams.
You can also pass an explicit array of parts for full control:

```js
multipart([
  { name: 'title', value: 'Report' },
  { name: 'attachment', value: buffer, filename: 'a.bin', contentType: 'application/octet-stream' }
]);
```

## Streaming responses

Buffered responses are the default. Use `responseType: 'stream'` for large
downloads so the body is not held in memory.

```js
const { request } = require('yareq');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');

const response = await request('https://example.com/archive.tar', {
  responseType: 'stream'
});

await pipeline(response.body, createWriteStream('archive.tar'));
```

Redirects are followed (when enabled) *before* the stream is returned, so
`response.body` is always the final resource. A `StreamResponse` also exposes
`text()`, `json()`, `buffer()`, `toResponse()`, and `save()` — but each of those
consumes the stream, so call at most one.

## Redirects

Redirects are **not** followed by default; the 3xx response is returned as-is.
Set `redirect: 'follow'` to follow them.

```js
const response = await request('https://example.com/redirect', {
  redirect: 'follow',
  maxRedirects: 10 // default: 20
});

console.log(response.url);        // final URL after redirects
console.log(response.requestUrl); // original URL you requested
console.log(response.redirects);  // list of intermediate URLs
```

Following the standard, a `303` (and a `301`/`302` on a `POST`) is rewritten to
a `GET` with the body dropped; other redirects preserve the method and body. A
preserving redirect with a non-replayable (stream) body throws. Exceeding
`maxRedirects` throws [`TooManyRedirectsError`](#errors).

For safety, the `authorization` option is **not** re-sent when a redirect points
to a different origin (scheme, host, or port). Managed cookies (via `getCookie`)
and same-origin redirects keep it. A raw `Authorization` value set through
`headers` is your responsibility and is always sent.

## Retries

Retries are off by default. When enabled, the built-in safeguards only retry
idempotent methods (`GET`, `HEAD`, `OPTIONS`) on transient network errors and
common retryable status codes.

```js
await request('https://example.com/api/status', {
  retry: 3 // shorthand for { retries: 3 }
});

await request('https://example.com/api/status', {
  retry: {
    retries: 3,
    delay: 200,   // base delay in ms
    factor: 2,    // exponential backoff multiplier
    maxDelay: 5000,
    jitter: true  // randomize delays to avoid thundering herds
  }
});
```

Backoff for attempt _n_ (1-based) is `delay * factor^(n-1)`, capped at
`maxDelay`. When `respectRetryAfter` is on (the default), a `Retry-After`
response header overrides the computed delay.

To retry other methods, opt in explicitly — and use a **replayable** body
(anything except a raw stream). Attempting to retry a stream body throws a
`TypeError` up front.

```js
await request('https://example.com/api/items/1', {
  method: 'PUT',
  json: { name: 'updated' },
  retry: {
    retries: 2,
    methods: ['PUT']
  }
});
```

For full control, `delay` can be a function receiving a
[`RetryContext`](#retrycontext):

```js
retry: {
  retries: 5,
  delay: ({ attempt, statusCode, error }) => attempt * 100
}
```

## Authorization

Pass a structured basic-auth credential:

```js
await request('https://example.com/api/status', {
  authorization: { type: 'basic', username, password }
});
```

Or a complete `Authorization` header value:

```js
await request('https://example.com/api/status', {
  authorization: `Bearer ${token}`
});
```

Credentials embedded in the URL (`https://user:pass@host/`) are also honored.
See [Redirects](#redirects) for cross-origin behavior.

## Cookies

`yareq` does not manage a cookie store itself; you supply hooks. This pairs well
with [`tough-cookie`](https://www.npmjs.com/package/tough-cookie):

```js
const tough = require('tough-cookie');
const jar = new tough.CookieJar();

const options = {
  setCookie: (cookie, url) => jar.setCookieSync(cookie, url.href),
  getCookie: url => jar.getCookieStringSync(url.href)
};

await request('https://example.com/login', options);
await request('https://example.com/account', options); // sends stored cookies
```

`getCookie` is called before each request (including each redirect hop) with the
target `URL`; `setCookie` is called once per `Set-Cookie` header on every
response. Both may be async.

## Proxies

```js
await request('https://example.com', {
  proxy: 'http://127.0.0.1:8080'
});
```

HTTP, HTTPS CONNECT, and SOCKS proxy URLs are supported. HTTPS targets are
tunneled through an HTTP proxy with `CONNECT`.

SOCKS URLs name the protocol version and where host names are resolved:

| Scheme | Version | Host names resolved |
| --- | --- | --- |
| `socks5h://`, `socks://` | 5 | by the proxy |
| `socks5://` | 5 | locally |
| `socks4a://` | 4a | by the proxy |
| `socks4://` | 4 | locally |

Resolve through the proxy (`socks5h://`) when the proxy decides where requests
come from, as Tor does: a local lookup leaks the host name and may pick another
region's servers. Credentials go in the URL:
`socks5h://user:pass@127.0.0.1:1080`.

## Timeouts and cancellation

`timeout` (default `30000` ms) applies as a socket inactivity timeout; on expiry
the request is aborted with [`RequestTimeoutError`](#errors).

Pass an `AbortSignal` to cancel a request:

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000);

await request('https://example.com/slow', { signal: controller.signal });
```

## Saving and loading responses

A buffered `Response` can be serialized to disk (metadata + body) and read back
with `Response.load`:

```js
const { request, Response } = require('yareq');

const response = await request('https://example.com/data.json');
await response.save('response.bin');

const loaded = await Response.load('response.bin');
console.log(loaded.statusCode, loaded.json());
```

Options:

- `save(path, { compress: true })` — gzip textual bodies (text/json/xml/js).
  `Response.load` transparently decompresses.
- `save(path, { bodyOnly: true })` — write only the body, no metadata header.

`StreamResponse` also supports `save()` (streaming straight to disk).

## API reference

### `request(url, options?)`

```ts
function request(url: string | URL, options?: RequestOptions): Promise<Response>;
function request(
  url: string | URL,
  options: RequestOptions & { responseType: 'stream' }
): Promise<StreamResponse>;
```

Returns a [`Response`](#response) by default, or a [`StreamResponse`](#streamresponse)
when `responseType: 'stream'`. Rejects on network errors, timeouts, too many
redirects, or invalid arguments.

### `RequestOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `method` | `string` | `GET` / `POST` | HTTP method. Defaults to `POST` when a body/json is present, else `GET`. |
| `headers` | `object` \| iterable of `[key, value]` | — | Request headers. Case-insensitive; override auto-set headers. |
| `body` | `string` \| `Buffer` \| `Uint8Array` \| `URLSearchParams` \| `Readable` \| `MultipartBody` | — | Request body. Mutually exclusive with `json`. |
| `json` | `unknown` | — | Value serialized as JSON. Mutually exclusive with `body`. |
| `timeout` | `number` | `30000` | Socket inactivity timeout in ms. |
| `redirect` | `'manual'` \| `'follow'` | `'manual'` | Whether to follow 3xx redirects. |
| `maxRedirects` | `number` | `20` | Max redirects to follow before throwing. |
| `proxy` | `string` \| `URL` | — | Proxy URL (`http:`, `https:`, or a SOCKS scheme; see [Proxies](#proxies)). |
| `decompress` | `boolean` | `true` | Decode `gzip`/`deflate`/`br` response bodies. |
| `responseType` | `'buffer'` \| `'stream'` | `'buffer'` | Buffer the body or return a stream. |
| `retry` | `number` \| [`RetryOptions`](#retryoptions) | — | Retry policy. A number is shorthand for `{ retries }`. |
| `authorization` | [`Authorization`](#authorization-types) | — | Basic credentials or a raw header value. |
| `signal` | `AbortSignal` | — | Abort the request. |
| `getCookie` | `(url: URL) => string \| number \| undefined \| Promise<...>` | — | Supply a `Cookie` header before each request. |
| `setCookie` | `(cookie: string, url: URL) => void \| Promise<void>` | — | Called for each `Set-Cookie` response header. |

### `RetryOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `retries` | `number` | `0` | Number of retries after the first attempt. |
| `methods` | `string[]` | `['GET','HEAD','OPTIONS']` | Methods eligible for retry. |
| `statusCodes` | `number[]` | `[408,429,500,502,503,504]` | Status codes that trigger a retry. |
| `errorCodes` | `string[]` | `['EAI_AGAIN','ECONNRESET','ETIMEDOUT','ESOCKETTIMEDOUT']` | Error codes that trigger a retry. |
| `delay` | `number` \| `(ctx: RetryContext) => number` | `100` | Base delay in ms, or a function returning ms. |
| `factor` | `number` | `2` | Exponential backoff multiplier. |
| `maxDelay` | `number` | `30000` | Upper bound on any single delay. |
| `jitter` | `boolean` \| `number` | `false` | Randomize delays; `true` ≈ ±20%, or a ratio. |
| `respectRetryAfter` | `boolean` | `true` | Honor the `Retry-After` response header. |

### `RetryContext`

Passed to a `delay` function.

```ts
interface RetryContext {
  attempt: number;    // 1-based retry number
  retries: number;    // configured max retries
  method: string;
  url: string;
  statusCode?: number; // set for status-based retries
  error?: Error;       // set for error-based retries
}
```

### Authorization types

```ts
type Authorization = { type: 'basic'; username: string; password: string } | string;
```

### `Response`

The default result. Extends `ResponseMetadata`.

| Member | Type | Description |
| --- | --- | --- |
| `body` | `Buffer` | Raw (decoded) response body. |
| `text(encoding?)` | `string` | Body decoded as text (default `utf8`). |
| `json<T>()` | `T` | Body parsed as JSON. |
| `contentLength` | `number` | Body length in bytes. |
| `contentMD5` | `string` | Hex MD5 of the body. |
| `save(path, options?)` | `Promise<this>` | Persist to disk. |
| `Response.load(path)` | `Promise<Response>` | *(static)* Read a saved response. |

### `StreamResponse`

Returned when `responseType: 'stream'`. Extends `ResponseMetadata`.

| Member | Type | Description |
| --- | --- | --- |
| `body` | `Readable` | The response stream (decoded unless `decompress: false`). |
| `contentLength` | `number \| undefined` | From `Content-Length`, when not encoded. |
| `buffer()` | `Promise<Buffer>` | Consume the stream into a buffer. |
| `text(encoding?)` | `Promise<string>` | Consume the stream as text. |
| `json<T>()` | `Promise<T>` | Consume the stream and parse JSON. |
| `toResponse()` | `Promise<Response>` | Consume into a buffered `Response`. |
| `save(path, options?)` | `Promise<this>` | Stream to disk. |

The consuming methods each read the stream to completion, so call at most one.

### `ResponseMetadata`

Shared base of `Response` and `StreamResponse`.

| Member | Type | Description |
| --- | --- | --- |
| `url` | `string` | Final URL (after redirects). |
| `requestUrl` | `string` | The URL originally requested. |
| `statusCode` | `number` | HTTP status code. |
| `headers` | `object` | Response headers, lowercased keys. |
| `httpVersion` | `string` | e.g. `'1.1'`. |
| `redirects` | `string[]` | Intermediate URLs followed. |
| `ok` | `boolean` | `true` for 2xx. |
| `redirected` | `boolean` | `true` if any redirect was followed. |
| `contentType` | `string` | `Content-Type` header, or `''`. |
| `contentEncoding` | `string` | `Content-Encoding` header, or `''`. |
| `fetchStart` / `fetchEnd` | `Date` | Fetch start/end timestamps. |
| `fetchDuration` | `number` | Total fetch time in ms. |
| `header(name)` | `string \| undefined` | Get the first header value (case-insensitive). |
| `headerValues(name)` | `string[]` | Get all values for a header, useful for `set-cookie`. |

### `SaveOptions`

```ts
interface SaveOptions {
  compress?: boolean;  // gzip textual bodies (default false)
  bodyOnly?: boolean;  // write only the body, no metadata (default false)
}
```

### `multipart(parts, options?)` / `file(value, filename, contentType?, headers?)`

`multipart()` returns a `MultipartBody` for use as a request `body`. Accepts a
field map (`{ name: value }`, arrays expand to repeated fields) or an explicit
`MultipartPart[]`. `options.boundary` overrides the generated boundary.

`file()` wraps a value as a file part.

### Errors

| Class | `code` | Thrown when |
| --- | --- | --- |
| `RequestTimeoutError` | `ETIMEDOUT` | A request exceeds `timeout`. |
| `TooManyRedirectsError` | `ETOOMANYREDIRECTS` | Redirects exceed `maxRedirects`. |

Both extend `Error`. Standard Node network errors (with a `.code`) propagate
unchanged.

## License

MIT © Weidong Fang
