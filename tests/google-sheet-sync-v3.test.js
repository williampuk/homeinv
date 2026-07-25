'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

const context = {
  console,
  Date,
  JSON,
  Math,
  Number,
  String,
  Object,
  Array,
  isFinite,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest(_algorithm, text) {
      return Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest()).map(v => v > 127 ? v - 256 : v);
    }
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve('../GoogleSheetSync.js'), 'utf8'), context);

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (err) {
    console.error('not ok - ' + name);
    throw err;
  }
}

function state() {
  return context.normalizeSnapshot({
    meta: { locationsVersion: 1, categoriesVersion: 1, householdSettingsVersion: 1 },
    inventory: [{
      id: 'item-1', name: 'Batteries', itemType: 'stock', version: 4,
      stockEntries: [{ id: 'entry-1', version: 3, quantity: 10 }]
    }]
  }, 7);
}

function op(fields) {
  return Object.assign({
    opId: 'op-1', deviceId: 'dev-a', entityType: 'item', entityId: 'item-1',
    baseVersion: 0, payload: {}, createdAt: '2026-01-01T00:00:00.000Z'
  }, fields);
}

test('unknown operations are rejected during validation', function() {
  assert.equal(context.validateOperation(op({ type: 'MAGIC' })), 'UNKNOWN_OPERATION');
});

test('stale item updates return a version conflict without mutating state', function() {
  const s = state();
  const before = JSON.stringify(s);
  const result = context.applyOperation(s, op({
    type: 'ITEM_PUT', baseVersion: 3, payload: { item: { id: 'item-1', name: 'Changed' } }
  }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.actualVersion, 4);
  assert.equal(JSON.stringify(s), before);
});

test('stock deltas compose and negative stock is rejected', function() {
  const s = state();
  const plus = context.applyOperation(s, op({
    opId: 'plus', type: 'STOCK_ADJUST', entityType: 'stockEntry', entityId: 'entry-1',
    payload: { itemId: 'item-1', entryId: 'entry-1', delta: 5 }
  }));
  const minus = context.applyOperation(s, op({
    opId: 'minus', type: 'STOCK_ADJUST', entityType: 'stockEntry', entityId: 'entry-1',
    payload: { itemId: 'item-1', entryId: 'entry-1', delta: -2 }
  }));
  assert.equal(plus.status, 'applied');
  assert.equal(minus.status, 'applied');
  assert.equal(s.inventory[0].quantity, 13);
  const rejected = context.applyOperation(s, op({
    opId: 'too-much', type: 'STOCK_ADJUST', entityType: 'stockEntry', entityId: 'entry-1',
    payload: { itemId: 'item-1', entryId: 'entry-1', delta: -20 }
  }));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.errorCode, 'INSUFFICIENT_STOCK');
  assert.equal(s.inventory[0].quantity, 13);
});

test('committed applied receipts become duplicates', function() {
  const operation = op({ type: 'ITEM_DELETE', baseVersion: 4 });
  const hash = context.opHash(operation);
  const existing = { operationHash: hash, status: 'applied', serverSeq: 8, entityVersion: 5 };
  const result = context.resolveExistingOperation(operation, hash, existing, 8);
  assert.equal(result.status, 'duplicate');
});

test('uncommitted applied receipts are reapplied after failed snapshot commit', function() {
  const operation = op({ type: 'ITEM_DELETE', baseVersion: 4 });
  const hash = context.opHash(operation);
  const existing = { operationHash: hash, status: 'applied', serverSeq: 8, entityVersion: 5 };
  assert.equal(context.resolveExistingOperation(operation, hash, existing, 7), null);
});

test('conflict receipts remain conflicts rather than false duplicates', function() {
  const operation = op({ type: 'ITEM_PUT', baseVersion: 3, payload: { item: { id: 'item-1' } } });
  const hash = context.opHash(operation);
  const existing = { operationHash: hash, status: 'conflict', errorCode: 'VERSION_CONFLICT', actualVersion: 4 };
  const result = context.resolveExistingOperation(operation, hash, existing, 99);
  assert.equal(result.status, 'conflict');
  assert.equal(result.errorCode, 'VERSION_CONFLICT');
});

test('operation hash detects immutable field changes', function() {
  const a = op({ type: 'ITEM_DELETE', baseVersion: 4 });
  const b = Object.assign({}, a, { createdAt: '2026-01-02T00:00:00.000Z' });
  assert.notEqual(context.opHash(a), context.opHash(b));
});

console.log('All Google Apps Script sync v3 tests passed.');
