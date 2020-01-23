import { resolve as resolveUrl, URL } from 'url';
import { request as httpRequest, RequestOptions, IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import { Response } from './response';
import { parseUrl, pickAssign, setHeader, setProxy, inflate } from './utils';

const { version } = require('../package.json');

type RequestResult = [IncomingMessage, Buffer];

export interface WithUrl {
  [key: string]: any;
  url: string;
}

export interface BasicAuthorisation {
  type: 'basic';
  username: string;
  password: string;
}

export type Authorisation = BasicAuthorisation;

export interface Options {
  data?: any;
  followLocation?: boolean;
  getCookie?: (url: string) => string | number;
  setCookie?: (cookie: string, url: string) => void;
  headers?:
    | { [header: string]: string | string[] | undefined }
    | [string, string][];
  inflate?: boolean;
  maxRedirect?: number;
  proxy?: string;
  setHost?: boolean;
  timeout?: number;
  method?: string;
  authorisation?: Authorisation;
}

export async function request(
  url: string | WithUrl,
  options: Options = {}
): Promise<Response> {
  return requestInternal(url, options).then(result => <Response>result);
}

async function requestInternal(url: string | WithUrl, options: Options) {
  return new Promise((resolve, reject) => {
    const fetchStart = new Date();

    async function _request(url: string | WithUrl) {
      const request = await buildRequest(parseUrl(url), options);
      execute(request, options.data)
        .then(async result => {
          const [res, buf] = result;
          const encoding = res.headers['content-encoding'] || '';
          await setCookie(options, res.headers['set-cookie'], url);
          if (options.inflate !== false && /gzip|deflate/.test(encoding)) {
            inflate(buf, encoding).then(content => {
              _resolve(new Response(url, res, content));
            });
          } else {
            _resolve(new Response(url, res, buf));
          }
        })
        .catch(reject);
    }

    let redirectCount = 0;

    function _resolve(res: Response) {
      if (
        options.followLocation &&
        res.statusCode >= 300 &&
        res.statusCode <= 399 &&
        res.headers.location
      ) {
        if (redirectCount++ >= (options.maxRedirect || 50)) {
          reject(Error('Too many redirects'));
        } else {
          const baseUrl = typeof res.url === 'string' ? res.url : res.url.url;
          const nextUrl = resolveUrl(baseUrl, res.headers.location);
          redirectCount++;
          _request(nextUrl);
        }
      } else {
        if (redirectCount > 0) {
          res.effectiveUrl = <string>res.url;
          res.url = url;
        }
        res.fetchStart = fetchStart;
        res.fetchEnd = new Date();
        resolve(res);
      }
    }

    _request(url);
  });
}

async function setCookie(
  options: Options,
  cookie: string[] | undefined,
  url: string | WithUrl
) {
  if (cookie && typeof options.setCookie === 'function') {
    if (!Array.isArray(cookie)) {
      options.setCookie(cookie, typeof url === 'string' ? url : url.url);
    } else {
      for (const value of cookie) {
        options.setCookie(value, typeof url === 'string' ? url : url.url);
      }
    }
  }
}

async function buildRequest(
  url: URL,
  options: Options
): Promise<RequestOptions> {
  const request = pickAssign({}, url, ['protocol', 'hostname', 'path']);

  if (url.port) {
    request.port = parseInt(url.port);
  }

  if (url.username || url.password) {
    request.auth = `${url.username}:${url.password}`;
  }

  pickAssign(request, options, ['method', 'timeout']);

  if (!request.method) {
    request.method = options.data === undefined ? 'GET' : 'POST';
  }

  if (options.headers !== undefined) {
    request.headers = [];
    if (Array.isArray(options.headers)) {
      for (const header of options.headers) {
        request.headers.push([...header]);
      }
    } else {
      for (const key in options.headers) {
        request.headers.push([key, options.headers[key]]);
      }
    }
  } else {
    request.headers = [
      ['Accept-Encoding', 'gzip, deflate'],
      ['Accept-Language', 'en-AU,en;q=0.9'],
      ['Connection', 'keep-alive'],
      ['User-Agent', `Mozilla/5.0 Yareq/${version}`]
    ];
  }

  if (typeof options.data === 'object' && !(options.data instanceof Buffer)) {
    setHeader(request.headers, 'Content-Type', 'application/json');
  }

  if (options.setHost === undefined || options.setHost) {
    setHeader(request.headers, 'Host', url.host);
  }

  if (options.authorisation) {
    const authoriation = options.authorisation;
    switch (authoriation.type) {
      case 'basic':
        const { username, password } = authoriation;
        setHeader(
          request.headers,
          'Authorization',
          'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
        );
        break;
      default:
        throw Error(`Unsupported authorisation type: ${authoriation.type}`);
    }
  }

  if (options.proxy) {
    setProxy(request, options.proxy, url);
  }

  if (typeof options.getCookie === 'function') {
    const cookie = await options.getCookie(url.href);
    if (cookie) {
      setHeader(request.headers, 'Cookie', cookie);
    }
  }

  return request;
}

function execute(options: RequestOptions, data: any): Promise<RequestResult> {
  const request = options.protocol == 'http:' ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = request(options, res => {
      const chunks: Buffer[] = [];

      res.on('data', chunk => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve([res, Buffer.concat(chunks)]);
      });
    });

    req.on('socket', socket => {
      socket.setTimeout(options.timeout || 30000);
      socket.on('timeout', function() {
        req.abort();
        reject(Error('Timeout'));
      });
    });

    req.on('error', error => {
      if (!req.aborted) {
        reject(error);
      }
    });

    if (data !== undefined) {
      if (typeof data.pipe === 'function') {
        data.pipe(req);
        return;
      } else {
        if (typeof data === 'object' && !(data instanceof Buffer)) {
          data = JSON.stringify(data);
        }
        req.write(data);
      }
    }

    req.end();
  });
}
