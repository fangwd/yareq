import { readFile, writeFile } from 'fs';
import { gzip, gunzip } from 'zlib';
import { WithUrl } from '.';
import { IncomingHttpHeaders } from 'http';

import * as crypto from 'crypto';

export interface SaveOptions {
  compress?: boolean;
  bodyOnly?: boolean;
}

interface MessageInfo {
  httpVersion: string;
  statusCode?: number;
  headers: IncomingHttpHeaders | [string, string][];
}

export class Response {
  url: string | WithUrl;
  statusCode: number;
  headers: IncomingHttpHeaders;
  httpVersion: string;
  fetchStart: Date | null;
  fetchEnd: Date | null;
  effectiveUrl?: string | null;
  body: Buffer;

  constructor(url: string | WithUrl, res: MessageInfo, buf: Buffer) {
    this.url = url;
    this.statusCode = res.statusCode || -1;
    this.headers = Array.isArray(res.headers)
      ? toHeaders(res.headers)
      : res.headers;
    this.httpVersion = res.httpVersion;
    this.fetchStart = null;
    this.fetchEnd = null;
    this.effectiveUrl = null;
    this.body = buf;
  }

  get contentEncoding(): string {
    return <string>this.headers['content-encoding'];
  }

  get contentMD5(): string {
    return crypto
      .createHash('md5')
      .update(this.body)
      .digest('hex');
  }

  get contentLength(): number {
    return this.body.length;
  }

  get contentType(): string {
    return <string>this.headers['content-type'];
  }

  json(): any {
    return JSON.parse(this.body.toString());
  }

  save(path: string, options: SaveOptions = {}): Promise<Response> {
    const compress =
      options.compress &&
      /\b(text|json)\b/i.test(this.headers['content-type'] || '');
    const head = Buffer.from(
      JSON.stringify({
        url: this.url,
        statusCode: this.statusCode,
        headers: this.headers,
        httpVersion: this.httpVersion,
        fetchStart: this.fetchStart,
        fetchEnd: this.fetchEnd,
        effectiveUrl: this.effectiveUrl,
        _encoding: compress ? 'gzip' : null
      })
    );

    return new Promise((resolve, reject) => {
      const self = this;
      function save(buf: Buffer) {
        const data = options.bodyOnly
          ? buf
          : Buffer.concat([head, Buffer.from([0x0a]), buf]);
        writeFile(path, data, err => {
          if (err) reject(err);
          else resolve(self);
        });
      }
      const body = this.body || Buffer.from([]);
      if (compress && body.length > 0) {
        gzip(body, (err, buf) => {
          if (err) reject(err);
          else {
            save(buf);
          }
        });
      } else {
        save(body);
      }
    });
  }

  static load(path: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      readFile(path, (err, data) => {
        if (err) reject(err);
        else {
          const index = data.indexOf(0x0a),
            res = JSON.parse(data.slice(0, index).toString()),
            buf = data.slice(index + 1),
            gzip = res._encoding;
          const end = (buf: Buffer) => {
            const response = new Response(res.url, res, buf);
            response.fetchStart = new Date(res.fetchStart);
            response.fetchEnd = new Date(res.fetchEnd);
            resolve(response);
          };
          delete res._encoding;
          if (gzip && buf.length > 0) {
            gunzip(buf, (err, buf) => {
              if (err) reject(err);
              else {
                end(buf);
              }
            });
          } else {
            end(buf);
          }
        }
      });
    });
  }
}

function toHeaders(headers: [string, string][]): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const entry of headers) {
    const key = entry[0].toLowerCase();
    const value = entry[1];
    const existing = result[key];
    if (!existing) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  return result;
}
