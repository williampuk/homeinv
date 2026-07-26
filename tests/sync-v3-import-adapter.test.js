'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const adapterSource = fs.readFileSync(require.resolve('../sync-v3-import-adapter.js'), 'utf8');

async function testDiffTranslation() {
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
  vm.runInContext(adapterSource, context);

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
}

async function runWrappedImport({ shouldCommit }) {
  const calls = [];
  const warnings = [];

  function NativeFileReader() {}
  NativeFileReader.prototype.readAsArrayBuffer = function() {
    try {
      this.onload({ target: { result: new ArrayBuffer(0) } });
    } catch (error) {
      // The legacy importer catches workbook errors in production. The test
      // keeps execution going so the adapter's queueing decision can settle.
    }
  };

  const context = {
    console: {
      log() {},
      error() {},
      warn(message) { warnings.push(String(message)); }
    },
    Promise, JSON, Object, Array, ArrayBuffer,
    window: null,
    appState: {
      inventory: [], segments: {}, coordinates: {}, categories: {},
      users: ['Default'], userEmails: {}, reminderDays: 30
    },
    FileReader: NativeFileReader,
    saveStateToLocalStorage() {},
    mutateState(type, metadata) { calls.push([type, metadata]); return Promise.resolve(); },
    importExcelToLocalDatabases() {
      const reader = new this.FileReader();
      reader.onload = () => {
        this.appState.inventory.push({ id: 'imported', name: 'Imported', itemType: 'unique', deletedAt: null });
        if (!shouldCommit) throw new Error('Malformed workbook');
        this.saveStateToLocalStorage();
      };
      reader.readAsArrayBuffer({});
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(adapterSource, context);
  context.importExcelToLocalDatabases({});
  await new Promise(resolve => setTimeout(resolve, 0));
  await Promise.resolve();
  return { calls, warnings };
}

async function main() {
  await testDiffTranslation();

  const committed = await runWrappedImport({ shouldCommit: true });
  assert.deepEqual(committed.calls.map(call => call[0]), ['COMMIT_ITEM']);

  const failed = await runWrappedImport({ shouldCommit: false });
  assert.equal(failed.calls.length, 0, 'failed imports must not enqueue partially mutated state');
  assert.ok(failed.warnings.some(message => message.includes('did not reach its persistence point')));

  console.log('All sync v3 import adapter tests passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
