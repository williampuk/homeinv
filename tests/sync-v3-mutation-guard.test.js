'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  let durableState = { inventory: [] };
  let legacyWriteCalls = 0;
  let atomicWriteCalls = 0;

  const context = {
    console,
    Promise,
    window: null,
    idbPutAppState(state) {
      legacyWriteCalls += 1;
      durableState = JSON.parse(JSON.stringify(state));
      return Promise.resolve();
    },
    mutateState() {
      // This models the synchronous part of sync-v3 mutateState: its legacy save
      // attempts an unawaited IDB write, followed later by the authoritative
      // atomic state/outbox transaction.
      context.idbPutAppState({ inventory: [{ id: 'mutated-too-early' }] });
      return Promise.resolve().then(function() {
        assert.deepEqual(durableState, { inventory: [] });
        atomicWriteCalls += 1;
        durableState = { inventory: [{ id: 'committed' }] };
      });
    }
  };
  context.window = context;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../sync-v3-mutation-guard.js'), 'utf8'), context);

  assert.equal(context.mutateState.__syncV3MutationGuard, true);
  const originalIdbPut = context.idbPutAppState;
  await context.mutateState('COMMIT_ITEM', { itemId: 'committed' });

  assert.equal(context.idbPutAppState, originalIdbPut);
  assert.equal(legacyWriteCalls, 0);
  assert.equal(atomicWriteCalls, 1);
  assert.deepEqual(durableState, { inventory: [{ id: 'committed' }] });

  console.log('All sync v3 mutation guard tests passed.');
}

main().catch(function(error) {
  console.error(error);
  process.exitCode = 1;
});
