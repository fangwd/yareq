'use strict'

const ya = require('../')

let url, options = {}

for (let i = 2, argv = process.argv; i < argv.length; i++) {
  let key = argv[i]
  if (key === '--proxy') {
    if (i + 1 < argv.length && argv[i + 1][0] !== '-') {
      options.proxy = argv[++i]
    }
    else {
      console.error(`Bad proxy ${argv[i + 1]}`)
      process.exit(1)
    }
  }
  else if (key === '--data') {
    if (i + 1 < argv.length) {
      options.data = argv[++i]
    }
  }
  else {
    url = key
  }
}

if (!url) {
  console.error(`Usage: fetch.js [--proxy <proxy>] [--data <data>] url`)
  process.exit(0)
}

ya(url, options, (err, res, body) => {
  if (err) throw err
  console.log(res.statusCode)
  console.log(res.headers)
  console.log(body.toString())
})
