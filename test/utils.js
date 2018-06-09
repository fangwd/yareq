const assert = require('assert')
const { setHeader } = require('../src/utils')

it('setHeader', () => {
  let headers

  headers = [['accept-encoding', 'gzip']]
  setHeader(headers, 'Cookie', 'id=1')
  assert.strictEqual(headers.length, 2)
  assert.strictEqual(headers[1][0], 'Cookie')

  headers = [['accept-encoding', 'gzip'], ['User-Agent', 'Mozilla/5.0']]
  setHeader(headers, 'cookie', 'id=1')
  assert.strictEqual(headers.length, 3)
  assert.strictEqual(headers[1][0], 'cookie')

  headers = []
  setHeader(headers, 'Cookie', 'id=1')
  assert.strictEqual(headers.length, 1)
  assert.strictEqual(headers[0][0], 'Cookie')

  headers = [['User-Agent', 'Mozilla/5.0']]
  setHeader(headers, 'Cookie', 'id=1')
  assert.strictEqual(headers.length, 2)
  assert.strictEqual(headers[0][0], 'Cookie')
})
