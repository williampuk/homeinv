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

  var _lastOpMs = 0;
  var _opCounter = 0;

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
      var result = {};
      Object.keys(value).sort().forEach(function(key) {
        result[key] = stableValue(value[key]);
      });
      return result;
    }
    return value;
  }

  function stableStringify(value) {
    return JSON.stringify(stableValue(value));
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

  function nextLocalOrder() {
    var now = Date.now();
    if (now !== _lastOpMs) {
      _lastOpMs = now;
      _opCounter = 0;
    } else {
      _opCounter += 1;
    }
    return now * 1000 + _opCounter;
  }

  function makeOpId(deviceId, localOrder) {
    return 'op_' + deviceId + '_' + Number(localOrder || nextLocalOrder()).toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function makeOperation(input) {
    input = input || {};
    var localOrder = Number(input.localOrder || nextLocalOrder());
    return {
      opId: input.opId || makeOpId(input.deviceId || 'device', localOrder),
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId || '',
      baseVersion: Number(input.baseVersion || 0),
      dependsOnOpId: input.dependsOnOpId || null,
      deviceId: input.deviceId || '',
      createdAt: input.createdAt || new Date().toISOString(),
      localOrder: localOrder,
      payload: clone(input.payload || {}),
      status: input.status || 'pending'
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
    var payload = { itemId: itemId, entry: stripEntryServerFields(entry) };
    if (Number(baseVersion || 0) === 0) payload.initialQuantity = Number(initialQuantity || 0);
    return makeOperation({
      type: OP_TYPES.STOCK_ENTRY_PUT,
      entityType: 'stockEntry',
      entityId: entry.id,
      baseVersion: baseVersion,
      deviceId: deviceId,
      dependsOnOpId: dependency || null,
      payload: payload
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

  function operationOrder(a, b) {
    var ao = Number(a && a.localOrder || 0);
    var bo = Number(b && b.localOrder || 0);
    if (ao !== bo) return ao - bo;
    var at = String(a && a.createdAt || '');
    var bt = String(b && b.createdAt || '');
    if (at !== bt) return at.localeCompare(bt);
    return String(a && a.opId || '').localeCompare(String(b && b.opId || ''));
  }

  function sortOperations(operations) {
    var list = (operations || []).slice().sort(operationOrder);
    var byId = {};
    list.forEach(function(op) { if (op && op.opId) byId[op.opId] = op; });
    var visiting = {};
    var visited = {};
    var output = [];

    function visit(op) {
      if (!op || !op.opId || visited[op.opId]) return;
      if (visiting[op.opId]) return;
      visiting[op.opId] = true;
      if (op.dependsOnOpId && byId[op.dependsOnOpId]) visit(byId[op.dependsOnOpId]);
      visiting[op.opId] = false;
      visited[op.opId] = true;
      output.push(op);
    }

    list.forEach(visit);
    return output;
  }

  function bumpVersion(entity, minimum) {
    if (!entity) return;
    entity.version = Math.max(Number(entity.version || 0) + 1, Number(minimum || 0));
  }

  function applyProjectedOperation(state, op) {
    state = state || {};
    state.meta = state.meta || {};
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
            version: 1,
            stockEntries: [],
            deletedAt: null
          });
          state.inventory.push(item);
        } else {
          item = state.inventory[index];
          var preservedEntries = clone(item.stockEntries || []);
          state.inventory[index] = Object.assign({}, item, clone(payload.item || {}), {
            id: op.entityId,
            version: Math.max(Number(item.version || 0) + 1, Number(op.baseVersion || 0) + 1),
            stockEntries: preservedEntries,
            deletedAt: item.deletedAt || null
          });
        }
        break;
      case OP_TYPES.ITEM_DELETE:
        item = findItem(state, op.entityId);
        if (item) {
          item.deletedAt = item.deletedAt || op.createdAt;
          bumpVersion(item, Number(op.baseVersion || 0) + 1);
        }
        break;
      case OP_TYPES.STOCK_ENTRY_PUT:
        item = findItem(state, payload.itemId);
        if (!item || item.deletedAt) break;
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
          if (entry.hiddenAt) break;
          item.stockEntries[index] = Object.assign({}, entry, clone(payload.entry || {}), {
            id: op.entityId,
            quantity: Number(entry.quantity || 0),
            version: Math.max(Number(entry.version || 0) + 1, Number(op.baseVersion || 0) + 1),
            hiddenAt: null
          });
        }
        bumpVersion(item);
        item.quantity = stockTotal(item);
        break;
      case OP_TYPES.STOCK_ENTRY_DELETE:
        item = findItem(state, payload.itemId);
        entry = findEntry(item, payload.entryId);
        if (entry) {
          entry.hiddenAt = entry.hiddenAt || op.createdAt;
          bumpVersion(entry, Number(op.baseVersion || 0) + 1);
        }
        if (item) {
          bumpVersion(item);
          item.quantity = stockTotal(item);
        }
        break;
      case OP_TYPES.STOCK_ADJUST:
        item = findItem(state, payload.itemId);
        entry = findEntry(item, payload.entryId);
        if (entry && !entry.hiddenAt) {
          entry.quantity = Number(entry.quantity || 0) + Number(payload.delta || 0);
          bumpVersion(entry);
        }
        if (item) {
          bumpVersion(item);
          item.quantity = stockTotal(item);
        }
        break;
      case OP_TYPES.LOCATIONS_PUT:
        state.segments = clone(payload.segments || {});
        state.coordinates = clone(payload.coordinates || {});
        state.spatialBackgroundImage = payload.spatialBackgroundImage || null;
        state.meta.locationsVersion = Math.max(Number(state.meta.locationsVersion || 0) + 1, Number(op.baseVersion || 0) + 1);
        break;
      case OP_TYPES.CATEGORIES_PUT:
        state.categories = clone(payload.categories || {});
        state.meta.categoriesVersion = Math.max(Number(state.meta.categoriesVersion || 0) + 1, Number(op.baseVersion || 0) + 1);
        break;
      case OP_TYPES.HOUSEHOLD_SETTINGS_PUT:
        state.users = clone(payload.users || ['Default']);
        state.userEmails = clone(payload.userEmails || {});
        state.reminderDays = Number(payload.reminderDays || 30);
        state.meta.householdSettingsVersion = Math.max(Number(state.meta.householdSettingsVersion || 0) + 1, Number(op.baseVersion || 0) + 1);
        break;
    }
    return state;
  }

  function isProjectedStatus(status) {
    return !status || ['pending', 'retry', 'conflict', 'blocked'].indexOf(status) !== -1;
  }

  function projectState(canonical, operations) {
    var projected = clone(canonical || {});
    sortOperations((operations || []).filter(function(op) {
      return isProjectedStatus(op.status);
    })).forEach(function(op) {
      applyProjectedOperation(projected, op);
    });
    return projected;
  }

  function latestDependency(ops, entityType, entityId) {
    var matching = (ops || []).filter(function(op) {
      return op.entityType === entityType && op.entityId === entityId && isProjectedStatus(op.status);
    }).sort(operationOrder);
    return matching.length ? matching[matching.length - 1] : null;
  }

  function affectsItem(op, itemId) {
    if (!op) return false;
    if (op.entityType === 'item' && op.entityId === itemId) return true;
    return !!(op.payload && op.payload.itemId === itemId);
  }

  function latestItemDependency(ops, itemId) {
    var matching = (ops || []).filter(function(op) {
      return affectsItem(op, itemId) && isProjectedStatus(op.status);
    }).sort(operationOrder);
    return matching.length ? matching[matching.length - 1] : null;
  }

  function selectPushBatch(operations, endpoint, processed, maxOperations) {
    processed = processed || {};
    var limit = Math.max(1, Number(maxOperations || 100));
    return sortOperations((operations || []).filter(function(op) {
      return op && op.syncEndpoint === endpoint &&
        ['pending', 'retry'].indexOf(op.status || 'pending') >= 0 &&
        !processed[op.opId];
    })).slice(0, limit);
  }

  function nextBaseVersion(serverVersion, dependency) {
    if (!dependency) return Number(serverVersion || 0);
    if (dependency.type === OP_TYPES.STOCK_ADJUST) return Number(serverVersion || 0);
    var dependencyBase = dependency.baseVersion !== undefined && dependency.baseVersion !== null
      ? Number(dependency.baseVersion)
      : Number(serverVersion || 0);
    return dependencyBase + 1;
  }

  function operationResultAction(result) {
    if (!result) return 'retry';
    if (result.status === 'applied' || result.status === 'duplicate') return 'delete';
    if (result.status === 'conflict') return 'conflict';
    if (result.status === 'blocked') return 'blocked';
    if (result.status === 'rejected') return 'rejected';
    return 'retry';
  }

  function descendantIds(operations, rootId) {
    var found = {};
    found[rootId] = true;
    var changed = true;
    while (changed) {
      changed = false;
      (operations || []).forEach(function(op) {
        if (op && op.opId && op.dependsOnOpId && found[op.dependsOnOpId] && !found[op.opId]) {
          found[op.opId] = true;
          changed = true;
        }
      });
    }
    return Object.keys(found);
  }

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    OP_TYPES: OP_TYPES,
    clone: clone,
    stableStringify: stableStringify,
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
    operationOrder: operationOrder,
    sortOperations: sortOperations,
    applyProjectedOperation: applyProjectedOperation,
    projectState: projectState,
    latestDependency: latestDependency,
    latestItemDependency: latestItemDependency,
    selectPushBatch: selectPushBatch,
    nextBaseVersion: nextBaseVersion,
    operationResultAction: operationResultAction,
    descendantIds: descendantIds
  };
});
