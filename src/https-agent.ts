import { request as httpRequest, RequestOptions } from 'http';
import { Agent, AgentOptions, request as httpsRequest } from 'https';
import { Duplex } from 'stream';
import { connect } from 'tls';
import { RequestTimeoutError } from './errors';

interface HttpsAgentOptions extends AgentOptions {
  proxy: URL;
  /** The `Proxy-Authorization` sent with CONNECT, if any. */
  authorization?: string;
  servername: string;
  timeout: number;
}

export class HttpsAgent extends Agent {
  private readonly proxy: URL;
  private readonly authorization?: string;
  private readonly servername: string;
  private readonly connectTimeout: number;

  constructor(options: HttpsAgentOptions) {
    const { proxy, authorization, servername, timeout, ...agentOptions } = options;
    super(agentOptions);
    this.proxy = proxy;
    this.authorization = authorization;
    this.servername = servername;
    this.connectTimeout = timeout;
  }

  createConnection(
    options: RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const done = callback as
      | ((err: Error | null, stream?: Duplex) => void)
      | undefined;
    let callbackCalled = false;
    const finish = (error: Error | null, stream?: Duplex) => {
      if (!callbackCalled) {
        callbackCalled = true;
        done?.(error, stream);
      }
    };
    const hostname = String(options.hostname || options.host || '');
    const port = String(options.port || 443);
    const connectPath = `${hostname}:${port}`;
    const request = this.proxy.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request({
      protocol: this.proxy.protocol,
      hostname: this.proxy.hostname,
      port: this.proxy.port || (this.proxy.protocol === 'https:' ? '443' : '80'),
      method: 'CONNECT',
      path: connectPath,
      headers: {
        Host: connectPath,
        ...(this.authorization ? { 'Proxy-Authorization': this.authorization } : {})
      }
    });

    req.setTimeout(this.connectTimeout, () => {
      req.destroy(new RequestTimeoutError(this.connectTimeout));
    });

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(
          new Error(`Proxy CONNECT failed with status ${res.statusCode || -1}`)
        );
        return;
      }

      const onStreamError = (error: Error) => finish(error, stream);
      // The request's TLS options (ca, rejectUnauthorized, ...) apply to the tunnelled connection.
      const { path: _path, port: _port, ...tlsOptions } = options;
      const stream = connect({ ...(tlsOptions as object), socket, servername: this.servername }, () => {
        stream.removeListener('error', onStreamError);
        finish(null, stream);
      });
      stream.once('error', onStreamError);
    });

    req.once('error', error => finish(error));
    req.end();

    return undefined;
  }
}
