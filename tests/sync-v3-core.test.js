'use strict';

const assert = require('node:assert/strict');
const Core = require('../sync-v3-core.js');

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

function snapshot() {
  return {
    protocolVersion: 3,
    meta: { serverSeq: 2, locationsVersion: 1, categoriesVersion: 1, householdSettingsVersion: 1 },
    segments: {}, coordinates: {}, categories: {}, users: ['Default'], userEmails: {}, reminderDays: 30,
    inventory: [{
      id: 'item-1', name: 'Batteries', itemType: 'stock', version: 4, deletedAt: null,
      stockEntries: [{ id: 'entry-1', version: 3, quantity: 10, hiddenAt: null }], quantity: 10
    }]
  };
}

test('protocol version is 3', function() {
  assert.equal(Core.PROTOCOL_VERSION, 3);
});

test('item put does not send stock or server fields', function() {
  const op = Core.itemPut({ id: 'item-1', name: 'New', version: 7, quantity: 5, stockEntries: [{ id: 'x' }] }, 6, 'dev-a');
  assert.equal(op.type, 'ITEM_PUT');
  assert.equal(op.baseVersion, 6);
  assert.equal(op.payload.item.name, 'New');
  assert.equal(Object.hasOwn(op.payload.item, 'version'), false);
  assert.equal(Object.hasOwn(op.payload.item, 'quantity'), false);
  assert.equal(Object.hasOwn(op.payload.item, 'stockEntries'), false);
});

test('stock adjustments compose instead of overwriting quantity', function() {
  const a = Core.stockAdjust('item-1', 'entry-1', -2, 'dev-a');
  const b = Core.stockAdjust('item-1', 'entry-1', 5, 'dev-b');
  const projected = Core.projectState(snapshot(), [a, b]);
  assert.equal(projected.inventory[0].stockEntries[0].quantity, 13);
  assert.equal(projected.inventory[0].quantity, 13);
});

test('item metadata projection preserves stock entries', function() {
  const op = Core.itemPut({ id: 'item-1', name: 'AA Batteries', itemType: 'stock' }, 4, 'dev-a');
  const projected = Core.projectState(snapshot(), [op]);
  assert.equal(projected.inventory[0].name, 'AA Batteries');
  assert.equal(projected.inventory[0].stockEntries[0].quantity, 10);
});

test('stock-entry metadata update preserves quantity', function() {
  const op = Core.stockEntryPut('item-1', { id: 'entry-1', segment: 'Kitchen' }, 3, 0, 'dev-a');
  const projected = Core.projectState(snapshot(), [op]);
  assert.equal(projected.inventory[0].stockEntries[0].segment, 'Kitchen');
  assert.equal(projected.inventory[0].stockEntries[0].quantity, 10);
});

test('delete produces a tombstone in projected state', function() {
  const op = Core.itemDelete('item-1', 4, 'dev-a');
  const projected = Core.projectState(snapshot(), [op]);
  assert.ok(projected.inventory[0].deletedAt);
});

test('only applied and duplicate results delete outbox entries', function() {
  assert.equal(Core.operationResultAction({ status: 'applied' }), 'delete');
  assert.equal(Core.operationResultAction({ status: 'duplicate' }), 'delete');
  assert.equal(Core.operationResultAction({ status: 'conflict' }), 'conflict');
  assert.equal(Core.operationResultAction({ status: 'rejected' }), 'rejected');
  assert.equal(Core.operationResultAction({ status: 'blocked' }), 'blocked');
  assert.equal(Core.operationResultAction(null), 'retry');
});

test('dependent version advances from predecessor base version', function() {
  const previous = Core.itemPut({ id: 'item-1', name: 'A' }, 4, 'dev-a');
  assert.equal(Core.nextBaseVersion(4, previous), 5);
  assert.equal(Core.latestDependency([previous], 'item', 'item-1').opId, previous.opId);
});

test('operation sort always places dependencies first', function() {
  const parent = Core.itemPut({ id: 'new-item', name: 'New', itemType: 'stock' }, 0, 'dev-a');
  const child = Core.stockEntryPut('new-item', { id: 'entry-new', segment: 'Kitchen' }, 0, 5, 'dev-a', parent.opId);
  child.localOrder = parent.localOrder - 1;
  const sorted = Core.sortOperations([child, parent]);
  assert.deepEqual(sorted.map(op => op.opId), [parent.opId, child.opId]);
});

test('conflicted operations remain projected but rejected operations do not', function() {
  const conflict = Core.itemPut({ id: 'item-1', name: 'Local conflict' }, 4, 'dev-a');
  conflict.status = 'conflict';
  const rejected = Core.itemPut({ id: 'item-1', name: 'Rejected' }, 4, 'dev-a');
  rejected.status = 'rejected';
  const projected = Core.projectState(snapshot(), [conflict, rejected]);
  assert.equal(projected.inventory[0].name, 'Local conflict');
});

test('latest dependency ignores resolved and conflicted operations', function() {
  const applied = Core.itemPut({ id: 'item-1', name: 'A' }, 4, 'dev-a');
  applied.status = 'applied';
  const conflict = Core.itemPut({ id: 'item-1', name: 'B' }, 4, 'dev-a');
  conflict.status = 'conflict';
  assert.equal(Core.latestDependency([applied, conflict], 'item', 'item-1'), null);
});

console.log('All sync v3 core tests passed.');
