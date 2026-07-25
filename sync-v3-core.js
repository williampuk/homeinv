(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SyncV3Core = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var PROTOCOL_VERSION = 3;
  var OP_TYPES = {
    ITEM_PUT: 'ITEM_PUT',
    ITEM_DELETE: 'ITEM_DELETE',
    STOCK_ENTRY_PUT: 'STOCK_ENTRY_PUT',
    STOCK_ENTRY_DELETE: 'STOCK_ENTRY_DELETE',
    STOCK_ADJUST: 'STOCK_ADJUST',
    LOCATIONS_PUT: 'LOCATIONS_PUT',
    CATEGORIES_PUT: 'CATEGORIES_PUT',
    HOUSEHOLD_SETTINGS_PUT: 'HOUSEHOLD_SETTINGS_PUT'
  };

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function activeEntries(item) {
    return ((item && item.stockEntries) || []).filter(function(entry) {
      return entry && !entry.hiddenAt;
    });
  }

  function stockTotal(item) {
    return activeEntries(item).reduce(function(sum, entry) {
      return sum + Number(entry.quantity || 0);
    }, 0);
  }

  function findItem(state, id) {
    return ((state && state.inventory) || []).find(function(item) {
      return item && item.id === id;
    }) || null;
  }

  function findEntry(item, id) {
    return ((item && item.stockEntries) || []).find(function(entry) {
      return entry && entry.id === id;
    }) || null;
  }

  function stripServerFields(item) {
    var copy = clone(item || {});
    delete copy.version;
    delete copy.createdAt;
    delete copy.updatedAt;
    delete copy.deletedAt;
    delete copy.lastModifiedBy;
    delete copy.quantity;
    delete copy.stockEntries;
    return copy;
  }

  function stripEntryServerFields(entry) {
    var copy = clone(entry || {});
    delete copy.version;
    delete copy.createdAt;
    delete copy.updatedAt;
    delete copy.hiddenAt;
    delete copy.quantity;
    return copy;
  }

  function makeOpId(deviceId) {
    return 'op_' + deviceId + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function makeOperation(input) {
    input = input || {};
    return {
      opId: input.opId || makeOpId(input.deviceId || 'device'),
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId || '',
      baseVersion: Number(input.baseVersion || 0),
      dependsOnOpId: input.dependsOnOpId || null,
      deviceId: input.deviceId || '',
      createdAt: input.createdAt || new Date().toISOString(),
      payload: clone(input.payload || {}),
      status: 'pending'
    };
  }

  function itemPut(item, baseVersion, deviceId, dependency) {
    return makeOperation({
      type: OP_TYPES.ITEM_PUT,
      entityType: 'item',
      entityId: item.id,
      baseVersion: baseVersion,
      deviceId: deviceId,
      dependsOnOpId: dependency || null,
      payload: { item: stripServerFields(item) }
    });
  }

  function itemDelete(itemId, baseVersion, deviceId, dependency) {
    return makeOperation({
      type: OP_TYPES.ITEM_DELETE,
      entityType: 'item',
      entityId: itemId,
      baseVersion: baseVersion,
      deviceId: deviceId,
      dependsOnOpId: dependency || null,
      payload: {}
    });
  }

  function stockEntryPut(itemId, entry, baseVersion, initialQuantity, deviceId, dependency) {
    return makeOperation({
      type: OP_TYPES.STOCK_ENTRY_PUT,
      entityType: 'stockEntry',
      entityId: entry.id,
      baseVersion: baseVersion,
      deviceId: deviceId,
      dependsOnOpId: dependency || null,
      payload: {
        itemId: itemId,
        entry: stripEntryServerFields(entry),
        initialQuantity: baseVersion === 0 ? Number(initialQuantity || 0) : undefined
      }
    });
  }

  function stockEntryDelete(itemId, entryId, baseVersion, deviceId, dependency) {
    return makeOperation({
      type: OP_TYPES.STOCK_ENTRY_DELETE,
      entityType: 'stockEntry',
      entityId: entryId,
      baseVersion: baseVersion,
      deviceId: deviceId,
      dependsOnOpId: dependency || null,
      payload: { itemId: itemId, entryId: entryId }
    });
  }

  function stockAdjust(itemId, entryId, delta, deviceId, dependency) {
    return makeOperation({
      type: OP_TYPES.STOCK_ADJUST,
      entityType: 'stockEntry',
      entityId: entryId,
      baseVersion: 0,
      deviceId: deviceId,
      dependsOnOpId: dependency || null,
      payload: { itemId: itemId, entryId: entryId, delta: Number(delta) }
    });
  }

  function locationsPut(state, baseVersion, deviceId, dependency) {
    return makeOperation({
      type: OP_TYPES.LOCATIONS_PUT,
      entityType: 'locations',
      entityId: 'locations',
      baseVersion: baseVersion,
      deviceId: deviceId,
      dependsOnOpId: dependency || null,
      payload: {
        segments: clone(state.segments || {}),
        coordinates: clone(state.coordinates || {}),
        spatialBackgroundImage: state.spatialBackgroundImage || null
      }
    });
  }

  function categoriesPut(state, baseVersion, deviceId, dependency) {
    return makeOperation({
      type: OP_TYPES.CATEGORIES_PUT,
      entityType: 'categories',
      entityId: 'categories',
      baseVersion: baseVersion,
      deviceId: deviceId,
      dependsOnOpId: dependency || null,
      payload: { categories: clone(state.categories || {}) }
    });
  }

  function householdSettingsPut(state, baseVersion, deviceId, dependency) {
    return makeOperation({
      type: OP_TYPES.HOUSEHOLD_SETTINGS_PUT,
      entityType: 'householdSettings',
      entityId: 'householdSettings',
      baseVersion: baseVersion,
      deviceId: deviceId,
      dependsOnOpId: dependency || null,
      payload: {
        users: clone(state.users || ['Default']),
        userEmails: clone(state.userEmails || {}),
        reminderDays: Number(state.reminderDays || 30)
      }
    });
  }

  function applyProjectedOperation(state, op) {
    state = state || {};
    state.inventory = state.inventory || [];
    var item;
    var entry;
    var index;
    var payload = op.payload || {};

    switch (op.type) {
      case OP_TYPES.ITEM_PUT:
        index = state.inventory.findIndex(function(candidate) { return candidate.id === op.entityId; });
        if (index < 0) {
          item = Object.assign({}, clone(payload.item || {}), {
            id: op.entityId,
            version: Math.max(1, Number(op.baseVersion || 0) + 1),
            stockEntries: []
          });
          state.inventory.push(item);
        } else {
          item = state.inventory[index];
          var preservedEntries = clone(item.stockEntries || []);
          state.inventory[index] = Object.assign({}, item, clone(payload.item || {}), {
            id: op.entityId,
            version: Math.max(Number(item.version || 0), Number(op.baseVersion || 0) + 1),
            stockEntries: preservedEntries,
            deletedAt: item.deletedAt || null
          });
        }
        break;
      case OP_TYPES.ITEM_DELETE:
        item = findItem(state, op.entityId);
        if (item) item.deletedAt = item.deletedAt || op.createdAt;
        break;
      case OP_TYPES.STOCK_ENTRY_PUT:
        item = findItem(state, payload.itemId);
        if (!item) break;
        item.stockEntries = item.stockEntries || [];
        index = item.stockEntries.findIndex(function(candidate) { return candidate.id === op.entityId; });
        if (index < 0) {
          item.stockEntries.push(Object.assign({}, clone(payload.entry || {}), {
            id: op.entityId,
            quantity: Number(payload.initialQuantity || 0),
            version: 1,
            hiddenAt: null
          }));
        } else {
          entry = item.stockEntries[index];
          item.stockEntries[index] = Object.assign({}, entry, clone(payload.entry || {}), {
            id: op.entityId,
            quantity: Number(entry.quantity || 0),
            version: Math.max(Number(entry.version || 0), Number(op.baseVersion || 0) + 1),
            hiddenAt: entry.hiddenAt || null
          });
        }
        item.quantity = stockTotal(item);
        break;
      case OP_TYPES.STOCK_ENTRY_DELETE:
        item = findItem(state, payload.itemId);
        entry = findEntry(item, payload.entryId);
        if (entry) entry.hiddenAt = entry.hiddenAt || op.createdAt;
        if (item) item.quantity = stockTotal(item);
        break;
      case OP_TYPES.STOCK_ADJUST:
        item = findItem(state, payload.itemId);
        entry = findEntry(item, payload.entryId);
        if (entry) entry.quantity = Number(entry.quantity || 0) + Number(payload.delta || 0);
        if (item) item.quantity = stockTotal(item);
        break;
      case OP_TYPES.LOCATIONS_PUT:
        state.segments = clone(payload.segments || {});
        state.coordinates = clone(payload.coordinates || {});
        state.spatialBackgroundImage = payload.spatialBackgroundImage || null;
        break;
      case OP_TYPES.CATEGORIES_PUT:
        state.categories = clone(payload.categories || {});
        break;
      case OP_TYPES.HOUSEHOLD_SETTINGS_PUT:
        state.users = clone(payload.users || ['Default']);
        state.userEmails = clone(payload.userEmails || {});
        state.reminderDays = Number(payload.reminderDays || 30);
        break;
    }
    return state;
  }

  function projectState(canonical, operations) {
    var projected = clone(canonical || {});
    (operations || []).filter(function(op) {
      return !op.status || ['pending', 'retry', 'conflict', 'blocked'].indexOf(op.status) !== -1;
    }).sort(function(a, b) {
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    }).forEach(function(op) {
      applyProjectedOperation(projected, op);
    });
    return projected;
  }

  function latestDependency(ops, entityType, entityId) {
    var matching = (ops || []).filter(function(op) {
      return op.entityType === entityType && op.entityId === entityId &&
        ['applied', 'duplicate', 'rejected'].indexOf(op.status) === -1;
    });
    matching.sort(function(a, b) {
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
    return matching.length ? matching[matching.length - 1] : null;
  }

  function nextBaseVersion(serverVersion, dependency) {
    if (!dependency) return Number(serverVersion || 0);
    if (dependency.type === OP_TYPES.STOCK_ADJUST) return Number(serverVersion || 0);
    return Number(dependency.baseVersion || serverVersion || 0) + 1;
  }

  function operationResultAction(result) {
    if (!result) return 'retain';
    if (result.status === 'applied' || result.status === 'duplicate') return 'delete';
    if (result.status === 'conflict') return 'conflict';
    if (result.status === 'blocked') return 'blocked';
    return 'rejected';
  }

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    OP_TYPES: OP_TYPES,
    clone: clone,
    stockTotal: stockTotal,
    findItem: findItem,
    findEntry: findEntry,
    makeOperation: makeOperation,
    itemPut: itemPut,
    itemDelete: itemDelete,
    stockEntryPut: stockEntryPut,
    stockEntryDelete: stockEntryDelete,
    stockAdjust: stockAdjust,
    locationsPut: locationsPut,
    categoriesPut: categoriesPut,
    householdSettingsPut: householdSettingsPut,
    applyProjectedOperation: applyProjectedOperation,
    projectState: projectState,
    latestDependency: latestDependency,
    nextBaseVersion: nextBaseVersion,
    operationResultAction: operationResultAction
  };
});
