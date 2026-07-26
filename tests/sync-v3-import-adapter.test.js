'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  const calls = [];
  const context = {
    console, Promise, JSON, Object, Array,
    window: null,
    appState: {},
    FileReader: function() {},
    importExcelToLocalDatabases() {},
    mutateState(type, metadata) { calls.push([type, metadata]); return Promise.resolve(); }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../sync-v3-import-adapter.js'), 'utf8'), context);

  const before = {
    inventory: [{ id: 'existing', name: 'Old', itemType: 'unique', deletedAt: null }],
    segments: {}, coordinates: {}, categories: {}, users: ['Default'], userEmails: {}, reminderDays: 30
  };
  const after = {
    inventory: [
      { id: 'existing', name: 'Updated', itemType: 'unique', deletedAt: null },
      { id: 'new', name: 'Imported', itemType: 'unique', deletedAt: null }
    ],
    segments: { Imported: {} }, coordinates: {}, categories: { Imported: {} },
    users: ['Default', 'Importer'], userEmails: {}, reminderDays: 20
  };

  const count = await context.syncV3QueueImportedState(before, after);
  assert.equal(count, 5);
  assert.deepEqual(calls.map(call => call[0]), [
    'EDIT_ITEM', 'COMMIT_ITEM', 'SAVE_LAYOUT', 'SAVE_CLASSIFICATION', 'SET_REMINDER'
  ]);
  assert.equal(context.importExcelToLocalDatabases.__syncV3ImportWrapped, true);
  console.log('All sync v3 import adapter tests passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
