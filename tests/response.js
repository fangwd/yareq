'use strict'

const assert = require('assert'),
      Response = require('../lib/response')

let url = 'http://example.com/',
    head = {
      statusCode: 200,
      statusMessage: 'OK',
      headers: { server: 'unknown', connection: 'close' },
      httpVersion: '1.1',
      fetchStart: 123,
      fetchEnd: 456,
    },
    bodyList = [Buffer.from('hello'), '', Buffer.from([])],
    responseList = bodyList.map(body => new Response(url, head, body))

for (let i = 0; i < responseList.length; i++) {
  let response = responseList[i], path = `/tmp/${i}.txt`
  response.save(path).then(result => {
     Response.load(path).then(response2 => {
      assert(response2.body === response.body ||
             response2.body.toString() === response.body.toString())
    })
  })
  .catch(error => {
    throw error
  })
}

for (let i = 0; i < responseList.length; i++) {
  let response = responseList[i], path = `/tmp/${i}.dat`
  response.save(path, true).then(result => {
     Response.load(path).then(response2 => {
      assert(response2.body === response.body ||
             response2.body.toString() === response.body.toString())
    })
  })
  .catch(error => {
    throw error
  })
}

