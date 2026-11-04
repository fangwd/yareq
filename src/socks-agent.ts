import { ClientRequest } from 'http';
import { isIP, Socket } from 'net';
import { connect as tlsConnect } from 'tls';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { RequestTimeoutError } from './errors';

type ConnectOptions = Parameters<SocksProxyAgent['connect']>[1];

export class SocksAgent extends SocksProxyAgent {
  constructor(proxy: URL, private readonly requestTimeout: number) {
    super(proxy, { timeout: requestTimeout });
  }

  async connect(req: ClientRequest, options: ConnectOptions): Promise<Socket> {
    let socket: Socket;
    try {
      // Obtain the raw tunnel so our timeout handler also covers TLS negotiation.
      socket = await super.connect(req, { ...options, secureEndpoint: false });
    } catch (error) {
      // The socks package exposes negotiation timeouts without an error code.
      if (error instanceof Error && error.message === 'Proxy connection timed out') {
        throw new RequestTimeoutError(this.requestTimeout);
      }
      throw error;
    }

    // Run before socks-proxy-agent's handler, which destroys without an error.
    socket.prependOnceListener('timeout', () => {
      req.destroy(new RequestTimeoutError(this.requestTimeout));
    });

    if (!options.secureEndpoint) {
      return socket;
    }

    // Retain the target host for certificate verification when SNI is empty.
    // The supplied socket already connects through the proxy.
    const { path, port, ...tlsOptions } = options;
    const stream = tlsConnect({
      ...tlsOptions,
      servername: options.servername ?? (options.host && !isIP(options.host) ? options.host : undefined),
      socket
    });
    stream.once('error', error => {
      req.destroy(error);
      socket.destroy();
    });
    return stream;
  }
}
