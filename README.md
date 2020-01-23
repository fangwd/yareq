# yareq - Yet another request for node.js

## Install

```
$ npm install yareq
```

# Usage

```js
const { request } = require('yareq');

(async function(proxy) {
  const response = await request('https://www.google.com/', { proxy });
  console.log(response.statusCode); // 200
})('socks5://localhost:9050');
```

## Basic authorisation

```js
request('http://example.com/api/status', {
  authorisation: { type: 'basic', username, password }
});
```
