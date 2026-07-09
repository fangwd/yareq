export class RequestTimeoutError extends Error {
  code = 'ETIMEDOUT';

  constructor(timeout: number) {
    super(`Request timed out after ${timeout}ms`);
    this.name = 'RequestTimeoutError';
  }
}

export class TooManyRedirectsError extends Error {
  code = 'ETOOMANYREDIRECTS';

  constructor(maxRedirects: number) {
    super(`Too many redirects: exceeded ${maxRedirects}`);
    this.name = 'TooManyRedirectsError';
  }
}
