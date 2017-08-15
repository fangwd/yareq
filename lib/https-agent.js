'use strict'

const http = require('http'),
      https = require('https'),
      tls = require('tls')

class HttpsAgent extends https.Agent {

  constructor(options) {
    super(options)
    this.proxy = options.proxy
  }

  createConnection(url, next) {
    let req = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port,
      method: 'CONNECT',
      path: url.host + ':' + url.port,
      headers: {
        host: url.hostname
      }
    })

    req.on('connect', (res, socket, head) => {
      let stream = tls.connect({
        host: url.host,
        port: url.port,
        socket: socket
      },  () => next(null, stream))
    })

    req.on('error', err => next(err))

    req.end()
  }

}

module.exports = HttpsAgent

