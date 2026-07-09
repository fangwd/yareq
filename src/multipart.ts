import { randomBytes } from 'crypto';
import { OutgoingHttpHeaders } from 'http';
import { Readable } from 'stream';
import { HeadersInput, isReadable, normalizeHeaders } from './utils';

export type MultipartPrimitive = string | number | boolean;
export type MultipartPartBody = MultipartPrimitive | Buffer | Uint8Array | Readable;
export type MultipartFieldValue = MultipartPartBody | MultipartFile;
export type MultipartFields = Record<
  string,
  MultipartFieldValue | readonly MultipartFieldValue[]
>;

export interface MultipartPart {
  name: string;
  value: MultipartPartBody;
  filename?: string;
  contentType?: string;
  headers?: HeadersInput;
}

export interface MultipartFile {
  value: MultipartPartBody;
  filename: string;
  contentType?: string;
  headers?: HeadersInput;
}

export interface MultipartOptions {
  boundary?: string;
}

interface NormalizedPart {
  name: string;
  value: MultipartPartBody;
  filename?: string;
  contentType?: string;
  headers: OutgoingHttpHeaders;
}

export class MultipartBody {
  readonly boundary: string;
  readonly headers: OutgoingHttpHeaders;
  private readonly parts: NormalizedPart[];

  constructor(parts: MultipartPart[] | MultipartFields, options: MultipartOptions = {}) {
    this.boundary = options.boundary || createBoundary();
    this.parts = normalizeParts(parts);
    this.headers = {
      'Content-Type': `multipart/form-data; boundary=${this.boundary}`
    };

    const length = this.contentLength;
    if (length !== undefined) {
      this.headers['Content-Length'] = length;
    }
  }

  get replayable(): boolean {
    return this.parts.every(part => !isReadable(part.value));
  }

  get contentLength(): number | undefined {
    let length = Buffer.byteLength(`--${this.boundary}--\r\n`);

    for (const part of this.parts) {
      const bodyLength = partLength(part.value);
      if (bodyLength === undefined) {
        return undefined;
      }
      length += headerFor(this.boundary, part).length + bodyLength + 2;
    }

    return length;
  }

  stream(): Readable {
    return Readable.from(this.iterate());
  }

  async toBuffer(): Promise<Buffer> {
    if (!this.replayable) {
      throw new Error('Cannot buffer multipart body with stream parts');
    }

    const chunks: Buffer[] = [];
    for await (const chunk of this.iterate()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private async *iterate(): AsyncGenerator<Buffer> {
    for (const part of this.parts) {
      yield headerFor(this.boundary, part);
      yield* bodyFor(part.value);
      yield Buffer.from('\r\n');
    }
    yield Buffer.from(`--${this.boundary}--\r\n`);
  }
}

export function multipart(
  parts: MultipartPart[] | MultipartFields,
  options?: MultipartOptions
): MultipartBody {
  return new MultipartBody(parts, options);
}

export function file(
  value: MultipartPartBody,
  filename: string,
  contentType?: string,
  headers?: HeadersInput
): MultipartFile {
  return { value, filename, contentType, headers };
}

function normalizeParts(parts: MultipartPart[] | MultipartFields): NormalizedPart[] {
  if (Array.isArray(parts)) {
    return parts.map(normalizePart);
  }

  const result: NormalizedPart[] = [];
  for (const name of Object.keys(parts)) {
    const value = parts[name];
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      result.push(normalizePart({ name, ...toPartValue(entry) }));
    }
  }
  return result;
}

function normalizePart(part: MultipartPart): NormalizedPart {
  return {
    name: part.name,
    value: part.value,
    filename: part.filename,
    contentType: part.contentType,
    headers: normalizeHeaders(part.headers)
  };
}

function toPartValue(value: MultipartFieldValue): Omit<MultipartPart, 'name'> {
  if (isMultipartFile(value)) {
    return value;
  }
  return { value };
}

function isMultipartFile(value: MultipartFieldValue): value is MultipartFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'filename' in value &&
    'value' in value
  );
}

function headerFor(boundary: string, part: NormalizedPart): Buffer {
  const lines = [
    `--${boundary}`,
    contentDisposition(part)
  ];

  if (part.contentType) {
    lines.push(`Content-Type: ${part.contentType}`);
  }

  for (const key of Object.keys(part.headers)) {
    const value = part.headers[key];
    if (value !== undefined) {
      lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
  }

  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`);
}

function contentDisposition(part: NormalizedPart): string {
  const values = [`name="${escapeHeaderValue(part.name)}"`];
  if (part.filename) {
    values.push(`filename="${escapeHeaderValue(part.filename)}"`);
  }
  return `Content-Disposition: form-data; ${values.join('; ')}`;
}

async function* bodyFor(value: MultipartPartBody): AsyncGenerator<Buffer> {
  if (isReadable(value)) {
    for await (const chunk of value) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    return;
  }

  if (Buffer.isBuffer(value)) {
    yield value;
    return;
  }

  if (value instanceof Uint8Array) {
    yield Buffer.from(value);
    return;
  }

  yield Buffer.from(String(value));
}

function partLength(value: MultipartPartBody): number | undefined {
  if (isReadable(value)) {
    return undefined;
  }
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  if (value instanceof Uint8Array) {
    return value.byteLength;
  }
  return Buffer.byteLength(String(value));
}

function createBoundary(): string {
  return `yareq-${randomBytes(12).toString('hex')}`;
}

function escapeHeaderValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r|\n/g, ' ');
}
