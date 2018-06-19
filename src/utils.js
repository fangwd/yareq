const URL = require('url');
const zlib = require('zlib');
const socks = require('socks-wrapper');

function rewrite(url) {
  if (!/^\w+:/.test(url)) {
    if (url.substr(0, 2) !== '//') {
      url = 'http://' + url;
    } else {
      url = 'http:' + url;
    }
  }
  return url;
}

function parseUrl(url) {
  if (!url || url instanceof URL.Url) {
    return url;
  }

  if (typeof url === 'string') {
    return URL.parse(rewrite(url));
  }

  if (typeof url === 'object' && 'url' in url) {
    return URL.parse(rewrite(url.url));
  }

  return null;
}

function pickAssign(target, source, keys) {
  if (source) {
    for (const key of keys) {
      if (source[key] !== undefined) {
        target[key] = source[key];
      }
    }
  }
  return target;
}

function setHeader(headers, key, value) {
  const keyLower = key.toLowerCase();
  const header = [key, value];

  let i;
  for (i = 0; i < headers.length; i++) {
    const nameLower = headers[i][0].toLowerCase();
    if (keyLower === nameLower) {
      headers[i] = header;
      break;
    }
    if (keyLower < nameLower) {
      headers.splice(i, 0, header);
      break;
    }
  }
  if (i === headers.length) {
    headers.push(header);
  }
}

function inflate(content, encoding) {
  return new Promise(resolve => {
    if (encoding === 'gzip') {
      zlib.gunzip(content, function(err, buf) {
        if (err) throw Error(err);
        resolve(buf);
      });
    } else {
      zlib.inflate(content, function(err, buf) {
        if (err) {
          zlib.inflateRaw(content, function(err, buf) {
            if (err) throw Error(err);
            resolve(buf);
          });
        } else {
          resolve(buf);
        }
      });
    }
  });
}

const HttpsAgent = require('./https-agent');

function setProxy(request, proxyUrl, url) {
  const proxy = URL.parse(rewrite(proxyUrl));
  if (/^socks/.test(proxy.protocol)) {
    const T = request.protocol === 'http:' ? socks.HttpAgent : socks.HttpsAgent;
    request.agent = new T(proxy.port, proxy.hostname);
  } else {
    if (request.protocol === 'http:') {
      request.protocol = proxy.protocol;
      request.hostname = proxy.hostname;
      request.port = proxy.port;
      request.path = url.href;
    } else {
      const agent = new HttpsAgent({ proxy: proxy });
      request.port = request.port || 443;
      request.agent = agent;
    }
  }
}

module.exports = { parseUrl, pickAssign, setHeader, setProxy, inflate };
