'use strict'

const URL = require('url')
const http = require('http')
const https = require('https')
const { Response } = require('./src/response')
const { version } = require('./package.json')

const {
  parseUrl,
  pickAssign,
  setHeader,
  setProxy,
  inflate
} = require('./src/utils')

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    function _request(url) {
      const request = buildRequest(parseUrl(url), options)

      execute(request, options.data)
        .then(result => {
          const [res, buf] = result
          const encoding = res.headers['content-encoding']
          setCookie(options, res.headers['set-cookie'], url)
          if (
            options.inflateContent !== false &&
            /^gzip|deflate$/.test(encoding)
          ) {
            inflate(buf, res.headers['content-encoding']).then(content => {
              _resolve(new Response(url, res, content))
            })
          } else {
            _resolve(new Response(url, res, buf))
          }
        })
        .catch(reject)
    }

    let redirectCount = 0

    function _resolve(res) {
      if (
        options.followLocation &&
        res.statusCode >= 300 &&
        res.statusCode <= 399 &&
        res.headers.location
      ) {
        if (redirectCount++ >= (options.maxRedirect || 50)) {
          reject(Error('Too many redirects'))
        } else {
          const nextUrl = URL.parse(URL.resolve(res.url, res.headers.location))
          redirectCount++
          _request(nextUrl)
        }
      } else {
        resolve(res)
      }
    }

    _request(url)
  })
}

function setCookie(options, cookie, url) {
  if (cookie && typeof options.setCookie === 'function') {
    if (!Array.isArray(cookie)) {
      options.setCookie(cookie, url)
    } else {
      cookie.forEach(value => {
        options.setCookie(value, url)
      })
    }
  }
}

function buildRequest(url, options) {
  const request = pickAssign({}, url, ['protocol', 'hostname', 'path'])

  if (url.port !== '') {
    request.port = parseInt(url.port)
  }

  if (url.username || url.password) {
    request.auth = `${url.username}:${url.password}`
  }

  pickAssign(request, options, ['method', 'timeout'])

  if (!request.method) {
    request.method = options.data === undefined ? 'GET' : 'POST'
  }

  if (options.headers !== undefined) {
    request.headers = []
    if (Array.isArray(options.headers)) {
      for (const header of options.headers) {
        request.headers.push([...header])
      }
    } else {
      for (const key in options.headers) {
        request.headers.push([key, options.headers[key]])
      }
    }
  } else {
    request.headers = [
      ['Accept-Encoding', 'gzip, deflate, br'],
      ['Accept-Language', 'en-AU,en;q=0.9'],
      ['Connection', 'keep-alive'],
      ['User-Agent', `Mozilla/5.0 Yareq/${version}`]
    ]
  }

  if (options.setHost === undefined || options.setHost) {
    setHeader(request.headers, 'Host', url.hostname)
  }

  if (options.proxy) {
    setProxy(request, options.proxy, url)
  }

  if (typeof options.getCookie === 'function') {
    const cookie = options.getCookie(url)
    if (cookie) {
      setHeader(request.headers, 'Cookie', cookie)
    }
  }

  return request
}

function execute(options, data) {
  const proto = options.protocol == 'http:' ? http : https
  return new Promise((resolve, reject) => {
    const req = proto.request(options, res => {
      const chunks = []
      res.on('data', chunk => {
        chunks.push(chunk)
      })

      res.on('end', () => {
        resolve([res, Buffer.concat(chunks)])
      })
    })

    req.on('socket', socket => {
      socket.setTimeout(options.timeout || 30000)
      socket.on('timeout', function() {
        req.abort()
        reject(Error('Timeout'))
      })
    })

    req.on('error', error => {
      if (!req.aborted) {
        reject(Error(error))
      }
    })

    if (data !== undefined) {
      if (typeof data.pipe === 'function') {
        data.pipe(req)
        return
      } else {
        if (typeof data === 'object' && !(data instanceof Buffer)) {
          data = JSON.stringify(data)
        }
        req.write(data)
      }
    }

    req.end()
  })
}

module.exports = {
  get: request,
  post: (url, data, options) => {
    return request(url, Object.assign({}, options, { data }))
  },
  request,
  Response
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0
