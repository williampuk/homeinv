'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const listeners = {};
const context = {
  console,
  Promise,
  URL,
  Request: function Request(url) { this.url = url; },
  Response: function Response() {},
  fetch() { return Promise.reject(new Error('not used')); },
  caches: {},
  self: {
    location: { href: 'https://example.test/homeinv/service-worker.js', origin: 'https://example.test' },
    addEventListener(type, listener) { listeners[type] = listener; },
    skipWaiting() {},
    clients: { claim() {} }
  }
};

vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve('../service-worker.js'), 'utf8'), context);

assert.equal(context.isAppShellRequest(new URL('https://example.test/homeinv/app.js')), true);
assert.equal(context.isAppShellRequest(new URL('https://example.test/homeinv/')), true);
assert.equal(context.isAppShellRequest(new URL('https://example.test/homeinv/item-photo.jpg')), false);
assert.equal(context.isAppShellRequest(new URL('https://images.example/item-photo.jpg')), false);
assert.equal(typeof listeners.fetch, 'function');

const source = fs.readFileSync(require.resolve('../service-worker.js'), 'utf8');
assert.equal(source.includes("endsWith(path.replace('./', ''))"), false);
assert.equal(source.includes('sync-v3-mutation-guard.js'), true);

console.log('All service-worker routing tests passed.');
