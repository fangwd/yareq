import { parse, Url, URL } from 'url';
import { RequestOptions } from 'http';
import { HttpsAgent } from './https-agent';
import { WithUrl } from './request';
import * as zlib from 'zlib';

const socks = require('socks-wrapper');

export function rewrite(url: string): string {
  if (!/^\w+:/.test(url)) {
    if (url.substr(0, 2) !== '//') {
      url = 'http://' + url;
    } else {
      url = 'http:' + url;
    }
  }
  return url;
}

export function parseUrl(url: string | WithUrl) {
  const href = typeof url === 'string' ? url : url.url;
  return <URL>(<any>parse(rewrite(href)));
}

interface WithKey {
  [key: string]: any;
}

export function pickAssign(target: WithKey, source: WithKey, keys: string[]) {
  if (source) {
    for (const key of keys) {
      if (source[key] !== undefined) {
        target[key] = source[key];
      }
    }
  }
  return target;
}

export type Header = [string, string | number];

export function setHeader(
  headers: Header[],
  key: string,
  value: string | number
) {
  const keyLower = key.toLowerCase();
  const header: Header = [key, value];

  for (let i = 0; i < headers.length; i++) {
    const nameLower = headers[i][0].toLowerCase();
    if (keyLower === nameLower) {
      headers[i] = header;
      return;
    }
    if (keyLower < nameLower) {
      headers.splice(i, 0, header);
      return;
    }
  }

  headers.push(header);
}

export function inflate(content: Buffer, encoding: string): Promise<Buffer> {
  return new Promise(resolve => {
    if (encoding === 'gzip') {
      zlib.gunzip(content, function(err, buf) {
        if (err) throw err;
        resolve(buf);
      });
    } else {
      zlib.inflate(content, function(err, buf) {
        if (err) {
          zlib.inflateRaw(content, function(err, buf) {
            if (err) throw err;
            resolve(buf);
          });
        } else {
          resolve(buf);
        }
      });
    }
  });
}

export function setProxy(request: RequestOptions, proxyUrl: string, url: Url) {
  const proxy = parse(rewrite(proxyUrl));
  if (/^socks/.test(<string>proxy.protocol)) {
    const T = request.protocol === 'http:' ? socks.HttpAgent : socks.HttpsAgent;
    request.agent = new T(proxy.port, proxy.hostname);
  } else {
    if (request.protocol === 'http:') {
      request.protocol = proxy.protocol;
      request.hostname = proxy.hostname;
      request.port = proxy.port;
      request.path = url.href;
    } else {
      const agent = new HttpsAgent({ proxy, servername: <string>url.host });
      request.port = request.port || 443;
      request.agent = agent;
    }
  }
}
