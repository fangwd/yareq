'use strict'

const ya = require('../'),
      redirectUrl = 'http://localhost:3000/redirect',
      timeoutUrl = 'http://localhost:3000/socket-timeout'

function ok(val, msg) {
  msg = msg || ''
  console.log(val ? 'ok' : 'not ok', msg)
}

ya(redirectUrl, (err, res, body) => {
  ok(res.statusCode == 301, 'redirect=false')
})

ya(redirectUrl, { followLocation: true }, (err, res, body) => {
  if (err) throw err
  ok(res.statusCode == 200, 'redirect=true (status code)')
  ok(body.toString() === 'OK', 'redirect=true (content)')
})

ya(slowUrl, { socketTimeout: 500 }, (err, res, body) => {
  ok(err && err.code === 'ECONNRESET', 'Socket timeout')
})

