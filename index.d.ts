export declare class Response {
  url: string;
  statusCode: number;
  headers: { [key: string]: string | string[] };
  httpVersion: string;
  fetchStart: Date;
  fetchEnd: Date;
  body: Buffer;

  constructor(url: string, res: any, buf: Buffer);

  save(path: string, gzip?: boolean): Promise<Response>;

  static load(path: string): Promise<Response>;
}

export interface RequestOptions {
  setHost?: boolean;
  proxy?: string;
  timeout?: number;
  headers?: { [key: string]: string | number } | Array<[string, string]>;
}

export declare function request(
  url: string,
  options: RequestOptions
): Promise<Response>;
