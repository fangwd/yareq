'use strict'

const http = require('http'),
      URL = require('url')

http.createServer(function (req, res) {
  var url = URL.parse(req.url, true)
  if (url.path == '/slow-response') {
    let n = 0
    let t = setInterval(() => {
      if (!res) {
        clearInterval(t)
      }
      else {
        res.write((n++) + '\n')
        if (n >= 10) {
          clearInterval(t)
          res.end()
        }
      }
    }, 1000)
  }
  else if (url.path == '/socket-timeout') {
    res.write('Wait...\n')
    setTimeout(() => {
      res.end()
    }, 10000)
  }
  else if (url.path == '/redirect') {
    res.writeHead(301, {
      'Location': '/welcome'
    })
    res.end()
  }
  else {
    res.end('OK')
  }
  req.on('close', () => {
    res.destroy()
    res = null
  })
}).listen(3000)
