'use strict'

const URL    = require('url'),
      http   = require('http'),
      https  = require('https'),
      zlib   = require('zlib'),
      wrapper = require('socks-wrapper'),
      extend = require('util')._extend,
      Response = require('./lib/response.js'),
      HttpsAgent = require('./lib/https-agent')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0

const globals = { Response: Response }

globals.fetch = (origUrl, options={}) => {
  let url

  if (typeof origUrl === 'string' || (url instanceof URL.Url)) {
    url = origUrl
  }
  else if (origUrl && typeof origUrl === 'object' && ('url' in origUrl)) {
    url = origUrl.url
  }

  if (!url) return Promise.reject(Error('Bad url'))

  if (typeof options === 'string') {
    options = { proxy: options }
  }

  let headers = extend({
    'Accept-Encoding': 'gzip, deflate',
    'User-Agent': 'Mozilla/5.0 yareq/0.1'
  }, 'headers' in options ? options.headers : null)

  options = extend({
    socketTimeout: -1,
    followLocation: false,
    maxRedirect: 2,
    inflateContent: true
  }, options)

  options.headers = headers

  let data = null

  if ('data' in options) {
    data = options.data
    delete options.data
    if (data && !('method' in options)) {
      options.method = 'POST'
    }
  }

  function rewrite(url) {
    if (!/^\w+:/.test(url)) {
      if (url.substr(0,2) !== '//') {
        url = 'http://' + url
      }
      else {
        url = 'http:' + url
      }
    }
    return url
  }

  if (typeof url === 'string') {
    url = URL.parse(rewrite(url))
  }

  // This can be an instance of tough-cookie's CookieJar
  let cookieJar = null
  if ('cookieJar' in options) {
    cookieJar = options.cookieJar
    delete options.cookieJar
    let cookie = cookieJar.getCookieStringSync(url)
    if (cookie) {
      options.headers['Cookie'] = cookie
    }
  }

  let redirectCount = 0

  let doGet = (url, next) => {
    extend(options, url)
    let proto = url.protocol === 'https:' ? https : http
    if (options.proxy) {
      let proxy = URL.parse(rewrite(options.proxy))
      if (/^socks/.test(proxy.protocol)) {
        let Agent = proto === http ? wrapper.HttpAgent : wrapper.HttpsAgent
        options.agent = new Agent(proxy.port, proxy.hostname)
      }
      else {
        if (options.protocol === 'http:') {
          options.protocol = proxy.protocol
          options.host = proxy.hostname
          options.port = proxy.port
          options.path = url.href
          delete options.hostname
        }
        else {
          let agent = new HttpsAgent({ proxy: proxy })
          options.port = options.port || 443
          options.agent = agent
        }
      }
    }

    let onFetchStart = options.onFetchStart || globals.onFetchStart
    if (typeof onFetchStart === 'function') {
      onFetchStart(origUrl, options)
    }

    let req = proto.request(options, (res) => {
      if (cookieJar && ('set-cookie' in res.headers)) {
        let cookies = res.headers['set-cookie']
        if (!Array.isArray(cookies)) {
          cookieJar.setCookieSync(cookies, url.href)
        }
        else {
          cookies.forEach(cookie => {
            cookieJar.setCookieSync(cookie, url)
          })
        }
      }

      let chunks = []
      res.on('data', (chunk) => {
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (options.followLocation && res.statusCode >= 300 &&
            res.statusCode <= 399 && 'location' in res.headers) {
          if (redirectCount++ >= options.maxRedirect) {
            return next('Too many redirects')
          }
          url = URL.parse(URL.resolve(url.href, res.headers.location))
          return doGet(url, next)
        }
        if (redirectCount > 0) {
          res.headers['x-effective-url'] = url.href
        }
        let encoding = res.headers['content-encoding'],
            content = Buffer.concat(chunks)
        if (options.inflateContent && (encoding === 'gzip'||
            encoding === 'deflate')) {
          if (encoding === 'gzip') {
            zlib.gunzip(content, function(err, buf) {
              next(err, res, buf)
            })
          }
          else {
            zlib.inflate(content, function(err, buf) {
              if (err) {
                zlib.inflateRaw(content, function(err, buf) {
                  next(err, res, buf)
                })
              }
              else {
                next(err, res, buf)
              }
            })
          }
        }
        else {
          next(null, res, content)
        }
      })
    })

    if (options.socketTimeout > 0) {
      req.on('socket', function (socket) {
        if (options.socketTimeout < 100) {
          throw Error('Invalid socket timeout')
        }
        socket.setTimeout(options.socketTimeout)
        socket.on('timeout', function() {
          req.abort()
        })
      })
    }

    req.on('error', (err) => {
      next(err)
    })

    if (data) {
      if (typeof data.pipe === 'function') {
        data.pipe(req)
        return
      }
      else {
        if (typeof data === 'object' && !(data instanceof Buffer)) {
          data = JSON.stringify(data)
        }
        req.write(data)
      }
    }

    req.end()
  }

  return new Promise((resolve, reject) => {
    let fetchStart = Date.now()
    function cb(err, res, buf) {
      let onFetchEnd = options.onFetchEnd || globals.onFetchEnd
      if (typeof onFetchEnd === 'function') {
        onFetchEnd(origUrl, err, res, buf)
      }
      if (err) {
        reject(new Error(err))
      }
      else {
        res = Object.assign({}, res, {
          fetchStart: fetchStart,
          fetchEnd: Date.now()
        })
        resolve(new Response(origUrl, res, buf))
      }
    }
    if (data && typeof data.getHeaders === 'function') {
      const dataHeaders = data.getHeaders()
      for (let key in dataHeaders) {
        headers[key] = dataHeaders[key]
      }
    }
    if (data && typeof data.getLength === 'function') {
      data.getLength((err, length) => {
        if (err) {
          reject(new Error(err))
        }
        else {
          headers['Content-Length'] = length
          doGet(url, cb)
        }
      })
    }
    else {
      doGet(url, cb)
    }
  })
}

module.exports = globals
