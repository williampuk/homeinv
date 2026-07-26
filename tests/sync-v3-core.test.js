'use strict';

const assert = require('node:assert/strict');
const Core = require('../sync-v3-core.js');

function test(name, fn) {
  try { fn(); console.log('ok - ' + name); }
  catch (error) { console.error('not ok - ' + name); throw error; }
}

function snapshot() {
  return {
    protocolVersion: 3,
    meta: { serverSeq: 2, locationsVersion: 1, categoriesVersion: 1, householdSettingsVersion: 1 },
    segments: {}, coordinates: {}, categories: {}, users: ['Default'], userEmails: {}, reminderDays: 30,
    inventory: [{ id: 'item-1', name: 'Batteries', itemType: 'stock', version: 4, deletedAt: null,
      stockEntries: [{ id: 'entry-1', version: 3, quantity: 10, hiddenAt: null }], quantity: 10 }]
  };
}

test('protocol version is 3', function() { assert.equal(Core.PROTOCOL_VERSION, 3); });

test('item put removes stock and server-owned fields', function() {
  const op = Core.itemPut({ id: 'item-1', name: 'New', version: 7, quantity: 5, stockEntries: [{ id: 'x' }] }, 6, 'dev-a');
  assert.equal(op.type, 'ITEM_PUT');
  assert.equal(op.baseVersion, 6);
  assert.equal(Object.hasOwn(op.payload.item, 'version'), false);
  assert.equal(Object.hasOwn(op.payload.item, 'quantity'), false);
  assert.equal(Object.hasOwn(op.payload.item, 'stockEntries'), false);
});

test('stock adjustments compose and mirror server version increments', function() {
  const a = Core.stockAdjust('item-1', 'entry-1', -2, 'dev-a');
  const b = Core.stockAdjust('item-1', 'entry-1', 5, 'dev-b', a.opId);
  const projected = Core.projectState(snapshot(), [a, b]);
  assert.equal(projected.inventory[0].stockEntries[0].quantity, 13);
  assert.equal(projected.inventory[0].quantity, 13);
  assert.equal(projected.inventory[0].stockEntries[0].version, 5);
  assert.equal(projected.inventory[0].version, 6);
});

test('item metadata projection preserves stock entries', function() {
  const op = Core.itemPut({ id: 'item-1', name: 'AA Batteries', itemType: 'stock' }, 4, 'dev-a');
  const projected = Core.projectState(snapshot(), [op]);
  assert.equal(projected.inventory[0].name, 'AA Batteries');
  assert.equal(projected.inventory[0].stockEntries[0].quantity, 10);
  assert.equal(projected.inventory[0].version, 5);
});

test('stock-entry metadata update preserves quantity and advances parent version', function() {
  const op = Core.stockEntryPut('item-1', { id: 'entry-1', segment: 'Kitchen' }, 3, 0, 'dev-a');
  const projected = Core.projectState(snapshot(), [op]);
  assert.equal(projected.inventory[0].stockEntries[0].segment, 'Kitchen');
  assert.equal(projected.inventory[0].stockEntries[0].quantity, 10);
  assert.equal(projected.inventory[0].stockEntries[0].version, 4);
  assert.equal(projected.inventory[0].version, 5);
});

test('delete creates a versioned tombstone', function() {
  const projected = Core.projectState(snapshot(), [Core.itemDelete('item-1', 4, 'dev-a')]);
  assert.ok(projected.inventory[0].deletedAt);
  assert.equal(projected.inventory[0].version, 5);
});

test('document projections advance independent versions', function() {
  const projected = Core.projectState(snapshot(), [
    Core.locationsPut({ segments: { Kitchen: {} }, coordinates: {} }, 1, 'dev-a'),
    Core.categoriesPut({ categories: { Food: {} } }, 1, 'dev-a'),
    Core.householdSettingsPut({ users: ['Default', 'A'], userEmails: {}, reminderDays: 20 }, 1, 'dev-a')
  ]);
  assert.equal(projected.meta.locationsVersion, 2);
  assert.equal(projected.meta.categoriesVersion, 2);
  assert.equal(projected.meta.householdSettingsVersion, 2);
});

test('only applied and duplicate results delete outbox entries', function() {
  assert.equal(Core.operationResultAction({ status: 'applied' }), 'delete');
  assert.equal(Core.operationResultAction({ status: 'duplicate' }), 'delete');
  assert.equal(Core.operationResultAction({ status: 'conflict' }), 'conflict');
  assert.equal(Core.operationResultAction({ status: 'rejected' }), 'rejected');
  assert.equal(Core.operationResultAction({ status: 'blocked' }), 'blocked');
  assert.equal(Core.operationResultAction(null), 'retry');
});

test('base version zero is preserved for a dependent create', function() {
  const previous = Core.itemPut({ id: 'new-item', name: 'A' }, 0, 'dev-a');
  assert.equal(Core.nextBaseVersion(99, previous), 1);
});

test('operation sorting always places dependencies first', function() {
  const parent = Core.itemPut({ id: 'new-item', name: 'New', itemType: 'stock' }, 0, 'dev-a');
  const child = Core.stockEntryPut('new-item', { id: 'entry-new', segment: 'Kitchen' }, 0, 5, 'dev-a', parent.opId);
  child.localOrder = parent.localOrder - 1;
  assert.deepEqual(Core.sortOperations([child, parent]).map(op => op.opId), [parent.opId, child.opId]);
});

test('conflicted and blocked operations remain projected but rejected operations do not', function() {
  const conflict = Core.itemPut({ id: 'item-1', name: 'Conflict' }, 4, 'dev-a'); conflict.status = 'conflict';
  const blocked = Core.itemPut({ id: 'item-1', name: 'Blocked latest' }, 5, 'dev-a', conflict.opId); blocked.status = 'blocked';
  const rejected = Core.itemPut({ id: 'item-1', name: 'Rejected' }, 6, 'dev-a'); rejected.status = 'rejected';
  assert.equal(Core.projectState(snapshot(), [conflict, blocked, rejected]).inventory[0].name, 'Blocked latest');
});

test('latest dependency includes unresolved conflict and blocked changes', function() {
  const conflict = Core.itemPut({ id: 'item-1', name: 'A' }, 4, 'dev-a'); conflict.status = 'conflict';
  const blocked = Core.itemPut({ id: 'item-1', name: 'B' }, 5, 'dev-a', conflict.opId); blocked.status = 'blocked';
  assert.equal(Core.latestDependency([conflict, blocked], 'item', 'item-1').opId, blocked.opId);
});

test('descendantIds includes the complete dependent tree', function() {
  const root = Core.itemPut({ id: 'item-1', name: 'A' }, 4, 'dev-a');
  const child = Core.itemPut({ id: 'item-1', name: 'B' }, 5, 'dev-a', root.opId);
  const grandchild = Core.itemDelete('item-1', 6, 'dev-a', child.opId);
  assert.deepEqual(new Set(Core.descendantIds([grandchild, root, child], root.opId)), new Set([root.opId, child.opId, grandchild.opId]));
});

test('latest item dependency includes stock-entry operations affecting parent', function() {
  const entry = Core.stockEntryPut('item-1', { id: 'entry-2' }, 0, 1, 'dev-a');
  assert.equal(Core.latestItemDependency([entry], 'item-1').opId, entry.opId);
});

test('push batching is endpoint-scoped, bounded, and excludes processed operations', function() {
  const ops = [];
  for (let i = 0; i < 105; i += 1) {
    const op = Core.itemPut({ id: 'item-' + i, name: 'Item ' + i }, 0, 'dev-a');
    op.syncEndpoint = 'cloud-a'; ops.push(op);
  }
  const other = Core.itemPut({ id: 'other', name: 'Other' }, 0, 'dev-a'); other.syncEndpoint = 'cloud-b'; ops.push(other);
  const first = Core.selectPushBatch(ops, 'cloud-a', {}, 100);
  assert.equal(first.length, 100);
  const processed = Object.fromEntries(first.map(op => [op.opId, true]));
  assert.equal(Core.selectPushBatch(ops, 'cloud-a', processed, 100).length, 5);
});

test('stableStringify ignores object insertion order', function() {
  assert.equal(Core.stableStringify({ b: 2, a: { d: 4, c: 3 } }), Core.stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
});

console.log('All sync v3 core tests passed.');
