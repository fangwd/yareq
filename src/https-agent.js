'use strict';

const http = require('http'),
  https = require('https'),
  tls = require('tls');

class HttpsAgent extends https.Agent {
  constructor(options) {
    super(options);
    this.proxy = options.proxy;
    this.timeout = options.timeout || 5000;
  }

  createConnection(url, next) {
    let req = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port,
      method: 'CONNECT',
      path: url.hostname + ':' + url.port,
      headers: {
        host: url.hostname
      }
    });

    let timer,
      timeout = this.timeout;

    req.on('socket', socket => {
      timer = setTimeout(() => {
        socket.destroy();
        clearTimeout(timer);
      }, timeout);
    });

    req.on('connect', (res, socket, head) => {
      clearTimeout(timer);
      let stream = tls.connect(
        { socket },
        () => next(null, stream)
      );
      stream.on('error', next);
    });

    req.on('error', err => {
      clearTimeout(timer);
      next(err);
    });
    req.end();
  }
}

module.exports = HttpsAgent;
