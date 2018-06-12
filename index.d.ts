export declare class Response {
  url: string;
  statusCode: number;
  headers: { [key: string]: string };
  body: Buffer;
  save(path: string, gzip?: boolean): Promise<Response>;
  static load(path: string): Promise<Response>;
}

export interface RequestOptions {
  headers: { [key: string]: string | number } | Array<[string, string]>;
}

export interface UrlRecord {
  url: string;
}

export declare function request(
  url: string | UrlRecord,
  options: RequestOptions
): Promise<Response>;
