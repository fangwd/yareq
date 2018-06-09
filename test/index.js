const assert = require('assert')
const ya = require('..')
const tough = require('tough-cookie')

const HTTP_URL = 'http://testfront.net:8091'
const HTTPS_URL = 'https://testfront.net'

const SOCKS_PROXY = process.env.SOCKS_PROXY || 'socks4a://localhost:9050'
const HTTP_PROXY = process.env.HTTP_PROXY
const HTTPS_PROXY = process.env.HTTPS_PROXY || HTTP_PROXY

let ourIp

before(() => {
  return new Promise(resolve => {
    ya.get(HTTPS_URL).then(res => {
      ourIp = JSON.parse(res.body.toString()).address
      resolve()
    })
  })
})

it('get', done => {
  const p1 = ya.get(HTTPS_URL).then(res => {
    assert.strictEqual(res.statusCode, 200)
    done()
  })
})

it('post', done => {
  const url = `${HTTPS_URL}/echo`
  const data = 'hello'
  ya.post(url, data).then(res => {
    assert.strictEqual(res.body.toString(), data)
    done()
  })
})

it('post - json', done => {
  const url = `${HTTPS_URL}/echo`
  const options = { headers: { 'content-type': 'application/json' } }
  const data = { hello: 'world' }
  ya.post(url, data, options).then(res => {
    assert.strictEqual(res.headers['content-type'], 'application/json')
    assert.strictEqual(JSON.parse(res.body.toString()).hello, 'world')
    done()
  })
})

it('redirect', done => {
  const url = `${HTTPS_URL}/redirect`
  const p1 = ya.get(url).then(res => {
    assert.strictEqual(res.statusCode, 301)
    done()
  })
})

it('follow location', done => {
  const url = `${HTTPS_URL}/redirect`
  const p1 = ya.get(url, { followLocation: true }).then(res => {
    const ip = JSON.parse(res.body.toString()).address
    assert.strictEqual(ip, ourIp)
    assert.strictEqual(res.statusCode, 200)
    done()
  })
})

it('max redirect', done => {
  const url = `${HTTPS_URL}/redirect`
  const p1 = ya
    .get(url, { followLocation: true, maxRedirect: 2 })
    .catch(error => {
      assert.strictEqual(/^Too many/i.test(error.message), true)
      done()
    })
})

it('timeout', done => {
  const url = `${HTTPS_URL}/timeout`
  const p1 = ya.get(url, { timeout: 2000 }).catch(error => {
    assert.strictEqual(/^Timeout/i.test(error.message), true)
    done()
  })
})

it('cookie', done => {
  ya.get(HTTPS_URL).then(res => {
    const jar = new tough.CookieJar()
    const options = {
      setCookie: (cookie, url) => jar.setCookieSync(cookie, url),
      getCookie: url => jar.getCookieStringSync(url)
    }
    ya.get(HTTPS_URL, options).then(res => {
      ya.get(HTTPS_URL, options).then(res => {
        assert.strictEqual(!!JSON.parse(res.body).headers.cookie, true)
        done()
      })
    })
  })
})

it('proxy (http)', done => {
  ya.get(HTTP_URL, { proxy: HTTP_PROXY }).then(res => {
    const ip = JSON.parse(res.body.toString()).address
    assert.notStrictEqual(ip, ourIp)
    done()
  })
})

it('proxy (https)', done => {
  ya.get(HTTPS_URL, { proxy: HTTPS_PROXY }).then(res => {
    const ip = JSON.parse(res.body.toString()).address
    assert.notStrictEqual(ip, ourIp)
    done()
  })
})

it('socks proxy (http)', done => {
  ya.get(HTTP_URL, { proxy: SOCKS_PROXY }).then(res => {
    const ip = JSON.parse(res.body.toString()).address
    assert.notStrictEqual(ip, ourIp)
    done()
  })
})

it('socks proxy (https)', done => {
  ya.get(HTTPS_URL, { proxy: SOCKS_PROXY }).then(res => {
    const ip = JSON.parse(res.body.toString()).address
    assert.notStrictEqual(ip, ourIp)
    done()
  })
})
