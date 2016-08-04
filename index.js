'use strict'

const URL    = require('url'),
      http   = require('http'),
      https  = require('https'),
      extend = require('util')._extend

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0

module.exports = (url, options, next) => {
  if (typeof url === 'undefined') {
    throw 'Nothing to request'
  }

  if (typeof options == 'undefined' || typeof options === 'function') {
    next = options
    options = {}
  }

  let data = null

  if ('data' in options) {
    data = options.data
    delete options.data
    if (!('method' in options)) {
      options.method = 'POST'
    }
  }

  let dummy = (err, res, body) => {
    if (err) throw err
    console.log(`HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`)
    console.log(body.toString())
  }

  next = next || dummy

  if (typeof url === 'string') {
    if (!/^\w+:/.test(url)) {
      if (url.substr(0,2) !== '//') {
        url = 'http://' + url
      }
      else {
        url = 'http:' + url
      }
    }
    url = URL.parse(url)
  }

  extend(options, url)

  let proto = url.protocol === 'https:' ? https : http
  let req = proto.request(options, (res) => {
    let chunks = []
    res.on('data', (chunk) => {
      chunks.push(chunk)
    })
    res.on('end', () => {
      next(null, res, Buffer.concat(chunks))
    })
  })

  req.on('error', (err) => {
    next(err)
  })

  if (data) {
    if (typeof data === 'object') {
      data = JSON.stringify(data)
    }
    req.write(data)
  }

  req.end()
}
