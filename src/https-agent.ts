import { Agent, AgentOptions } from 'https';
import { Url } from 'url';
import { request } from 'http';
import { connect, TLSSocket } from 'tls';

interface HttpsAgentOptions extends AgentOptions {
  proxy: Url;
  servername: string;
  timeout?: number;
}

export class HttpsAgent extends Agent {
  options: HttpsAgentOptions;

  constructor(options: HttpsAgentOptions) {
    super(options);
    this.options = options;
  }

  createConnection(url: Url, next: any) {
    const req = request({
      host: this.options.proxy.hostname,
      port: this.options.proxy.port,
      method: 'CONNECT',
      path: url.hostname + ':' + url.port,
      headers: {
        host: url.hostname
      }
    });

    let timer: NodeJS.Timeout;

    req.on('socket', socket => {
      timer = setTimeout(() => {
        socket.destroy();
        clearTimeout(timer);
      }, this.options.timeout || 5000);
    });

    req.on('connect', (res, socket, head) => {
      clearTimeout(timer);
      const stream: TLSSocket = connect(
        { socket, servername: this.options.servername },
        () => next(null, stream)
      );
      stream.on('error', error => {
        next(error);
      });
    });

    req.on('error', err => {
      clearTimeout(timer);
      next(err);
    });

    req.end();
  }
}
