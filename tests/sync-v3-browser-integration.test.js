'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../sync-v3-core.js');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function requestResult(value) {
  const req = {};
  setTimeout(() => { if (req.onsuccess) req.onsuccess({ target: { result: value } }); }, 0);
  return req;
}

async function main() {
  const localValues = new Map();
  const appStateStore = new Map();
  const outboxStore = new Map();
  const baseline = {
    meta: { deviceId: 'dev-a' }, segments: {}, coordinates: {}, categories: {},
    users: ['Default'], userEmails: {}, reminderDays: 30, inventory: []
  };
  appStateStore.set('canonical', { key: 'canonical', value: clone(baseline) });

  function openStateDb() {
    return Promise.resolve({
      transaction() {
        const tx = { error: null };
        tx.objectStore = function(name) {
          const store = name === 'appState' ? appStateStore : outboxStore;
          return {
            get(key) { return requestResult(store.get(key)); },
            put(record) {
              store.set(name === 'appState' ? record.key : record.opId, clone(record));
              return requestResult(record);
            },
            delete(key) { store.delete(key); return requestResult(undefined); }
          };
        };
        setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
        return tx;
      }
    });
  }

  const context = {
    console, Promise, Date, Math, JSON, Number, String, Object, Array, Error,
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    window: null, globalThis: null, SyncV3Core: Core,
    localStorage: {
      getItem(key) { return localValues.has(key) ? localValues.get(key) : null; },
      setItem(key, value) { localValues.set(key, String(value)); },
      removeItem(key) { localValues.delete(key); }
    },
    navigator: { onLine: false },
    document: { getElementById() { return null; }, createElement() { return { appendChild() {}, style: {} }; }, body: { appendChild() {} } },
    appState: clone(baseline), openStateDb,
    getDeviceId() { return 'dev-a'; },
    idbGetAppState() { return Promise.resolve(clone(appStateStore.get('canonical')?.value || null)); },
    idbPutAppState(state) { appStateStore.set('canonical', { key: 'canonical', value: clone(state) }); return Promise.resolve(); },
    idbGetOutboxOps() { return Promise.resolve(Array.from(outboxStore.values()).map(clone)); },
    idbPutOutboxOp(op) { outboxStore.set(op.opId, clone(op)); return Promise.resolve(); },
    idbDeleteOutboxOp(id) { outboxStore.delete(id); return Promise.resolve(); },
    buildPersistedStateSnapshot(state) { return clone(state); },
    saveStateToLocalStorage() {}, updatePillSyncStatus() {}, updateSyncStatusBadge() {}, updateLoginSyncStatus() {},
    showLoadingCloudOverlay() {}, hideLoadingCloudOverlay() {}, showOfflineBanner() {}, hideOfflineBanner() {},
    showToast() {}, syncUIComponents() {}, normalizeAllItemImageFields() {},
    _syncInProgress: false, _outboxFlushInProgress: false, _syncLastFailed: false, _syncConflict: false
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../sync-v3.js'), 'utf8'), context);
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(context.__HOMEINV_SYNC_V3__, true);

  context.appState.inventory.push({ id: 'item-first', name: 'First', itemType: 'unique', version: 1, stockEntries: [], deletedAt: null });
  await context.mutateState('COMMIT_ITEM', { itemId: 'item-first' });
  let ops = Array.from(outboxStore.values()).sort(Core.operationOrder);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, 'ITEM_PUT');
  assert.equal(ops[0].baseVersion, 0);
  assert.equal(appStateStore.get('canonical').value.inventory[0].name, 'First');

  context.appState.inventory[0].name = 'Second';
  await context.mutateState('EDIT_ITEM', { itemId: 'item-first' });
  ops = Array.from(outboxStore.values()).sort(Core.operationOrder);
  assert.equal(ops.length, 2);
  assert.equal(ops[1].baseVersion, 1);
  assert.equal(ops[1].dependsOnOpId, ops[0].opId);

  context.appState.inventory.push({
    id: 'stock-new', name: 'Rice', itemType: 'stock', version: 1, deletedAt: null, quantity: 5,
    stockEntries: [{ id: 'entry-new', version: 1, quantity: 5, hiddenAt: null, segment: 'Kitchen' }]
  });
  await context.mutateState('COMMIT_ITEM', { itemId: 'stock-new' });
  ops = Array.from(outboxStore.values()).sort(Core.operationOrder);
  const stockItemOp = ops.find(op => op.type === 'ITEM_PUT' && op.entityId === 'stock-new');
  const stockEntryOp = ops.find(op => op.type === 'STOCK_ENTRY_PUT' && op.entityId === 'entry-new');
  assert.ok(stockItemOp);
  assert.ok(stockEntryOp);
  assert.equal(stockEntryOp.dependsOnOpId, stockItemOp.opId);

  context.appState.inventory.find(item => item.id === 'stock-new').name = 'Brown Rice';
  await context.mutateState('EDIT_ITEM', { itemId: 'stock-new' });
  ops = Array.from(outboxStore.values()).sort(Core.operationOrder);
  const stockMetadataOps = ops.filter(op => op.type === 'ITEM_PUT' && op.entityId === 'stock-new');
  assert.equal(stockMetadataOps.length, 2);
  assert.equal(stockMetadataOps[1].baseVersion, 2);
  assert.equal(stockMetadataOps[1].dependsOnOpId, stockEntryOp.opId);

  console.log('All sync v3 browser integration tests passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
