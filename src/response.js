'use strict'

const fs = require('fs'),
  zlib = require('zlib')

class Response {
  constructor(url, res, buf) {
    this.url = url
    this.statusCode = res.statusCode
    this.statusText = res.statusMessage
    this.headers = res.headers
    this.httpVersion = res.httpVersion
    this.fetchStart = res.fetchStart
    this.fetchEnd = res.fetchEnd
    this.body = buf
  }

  save(path, gzip) {
    let head = Buffer.from(
      JSON.stringify({
        url: this.url,
        statusCode: this.statusCode,
        statusMessage: this.statusMessage,
        headers: this.headers,
        httpVersion: this.httpVersion,
        fetchStart: this.fetchStart,
        fetchEnd: this.fetchEnd,
        _encoding: gzip ? 'gzip' : null
      })
    )

    return new Promise((resolve, reject) => {
      let self = this
      function save(buf) {
        fs.writeFile(path, buf, err => {
          if (err) reject(Error(err))
          else resolve(self)
        })
      }
      let body = this.body || Buffer.from([])
      if (gzip && body.length > 0) {
        zlib.gzip(body, (err, buf) => {
          if (err) reject(Error(err))
          else {
            save(Buffer.concat([head, Buffer.from([0x0a]), buf]))
          }
        })
      } else {
        save(Buffer.concat([head, Buffer.from([0x0a]), body]))
      }
    })
  }

  static load(path) {
    return new Promise((resolve, reject) => {
      fs.readFile(path, (err, data) => {
        if (err) reject(Error(err))
        else {
          let index = data.indexOf(0x0a),
            res = JSON.parse(data.slice(0, index).toString()),
            buf = data.slice(index + 1),
            gzip = res._encoding
          delete res._encoding
          if (gzip && buf.length > 0) {
            zlib.gunzip(buf, (err, buf) => {
              if (err) reject(Error(err))
              else resolve(new Response(res.url, res, buf))
            })
          } else resolve(new Response(res.url, res, buf))
        }
      })
    })
  }
}

module.exports = { Response }
