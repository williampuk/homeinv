'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  const values = new Map([['sys_gas_url', 'https://cloud-a.example']]);
  let resolveFetch;
  const nativeFetch = input => input === 'https://cloud-a.example'
    ? new Promise(resolve => { resolveFetch = resolve; })
    : Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
  const context = {
    window: null,
    fetch: nativeFetch,
    Response,
    JSON,
    String,
    localStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, String(value)); }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../sync-v3-endpoint-guard.js'), 'utf8'), context);

  const pending = context.fetch('https://cloud-a.example', { method: 'POST' });
  values.set('sys_gas_url', 'https://cloud-b.example');
  resolveFetch(new Response(JSON.stringify({ success: true }), { status: 200 }));
  const guarded = await pending;
  const body = await guarded.json();
  assert.equal(guarded.status, 409);
  assert.equal(body.errorCode, 'ENDPOINT_CHANGED');

  const unrelated = await context.fetch('https://api.deepseek.com/test');
  assert.equal(unrelated.status, 200);
  console.log('All sync v3 endpoint guard tests passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
