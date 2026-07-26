(function() {
  'use strict';

  if (!window.SyncV3Core) {
    console.error('[SyncV3] sync-v3-core.js was not loaded.');
    return;
  }

  window.__HOMEINV_SYNC_V3__ = true;

  var Core = window.SyncV3Core;
  var CANONICAL_RECORD_KEY = 'syncV3CanonicalByEndpoint';
  var BASELINE_RECORD_KEY = 'syncV3LocalBaselineByEndpoint';
  var LEGACY_CANONICAL_KEY = 'fmi_sync_v3_canonical';
  var LEGACY_INITIALIZED_KEY = 'fmi_sync_v3_initialized';
  var LOCAL_SCOPE = '__local_unconfigured__';
  var MAX_PUSH_OPERATIONS = 100;
  var REQUEST_TIMEOUT_MS = 30000;

  var _canonicalByEndpoint = {};
  var _baselineByEndpoint = {};
  var _syncQueue = Promise.resolve();
  var _mutationQueue = Promise.resolve();
  var _taskDepth = 0;
  var _protocolError = false;
  var _cloudInitialized = false;
  var _conflictPanel = null;
  var _lastSuccessfulEndpoint = '';

  function clone(value) { return Core.clone(value); }
  function currentEndpoint() { return String(localStorage.getItem('sys_gas_url') || ''); }
  function currentScope() { return currentEndpoint() || LOCAL_SCOPE; }

  function getStateRecord(key) {
    return openStateDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('appState', 'readonly');
        var req = tx.objectStore('appState').get(key);
        req.onsuccess = function() { resolve(req.result ? req.result.value : null); };
        req.onerror = function() { reject(req.error); };
      });
    });
  }

  function putStateRecord(key, value) {
    return openStateDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('appState', 'readwrite');
        tx.objectStore('appState').put({ key: key, value: value });
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
        tx.onabort = function() { reject(tx.error || new Error('IndexedDB transaction aborted.')); };
      });
    });
  }

  function loadRecordMap(value) {
    if (!value || typeof value !== 'object') return {};
    if (value.records && typeof value.records === 'object') return clone(value.records);
    return clone(value);
  }

  function persistCanonicalMap() {
    var value = { records: clone(_canonicalByEndpoint) };
    try { localStorage.setItem(LEGACY_CANONICAL_KEY, JSON.stringify(value)); } catch (ignore) {}
    return putStateRecord(CANONICAL_RECORD_KEY, value);
  }

  function persistBaselineMap() {
    return putStateRecord(BASELINE_RECORD_KEY, { records: clone(_baselineByEndpoint) });
  }

  function loadLegacyCanonicalMap() {
    try {
      var raw = localStorage.getItem(LEGACY_CANONICAL_KEY);
      if (!raw) return {};
      var value = JSON.parse(raw);
      if (value && value.records) return loadRecordMap(value);
      var endpoint = currentEndpoint();
      if (endpoint && value && value.protocolVersion === Core.PROTOCOL_VERSION) {
        var migrated = {};
        migrated[endpoint] = value;
        return migrated;
      }
    } catch (ignore) {}
    return {};
  }

  var _storageReady = Promise.all([
    getStateRecord(CANONICAL_RECORD_KEY).catch(function() { return null; }),
    getStateRecord(BASELINE_RECORD_KEY).catch(function() { return null; })
  ]).then(function(values) {
    _canonicalByEndpoint = loadRecordMap(values[0]);
    if (!Object.keys(_canonicalByEndpoint).length) _canonicalByEndpoint = loadLegacyCanonicalMap();
    _baselineByEndpoint = loadRecordMap(values[1]);
    _cloudInitialized = !!getCanonicalSnapshot();
  });

  function emptySharedSnapshot() {
    return {
      protocolVersion: Core.PROTOCOL_VERSION,
      schemaVersion: '3.0.0',
      meta: { initialized: false, serverSeq: 0, locationsVersion: 0, categoriesVersion: 0, householdSettingsVersion: 0 },
      segments: {}, coordinates: {}, spatialBackgroundImage: null, categories: {}, inventory: [],
      users: ['Default'], userEmails: {}, reminderDays: 30
    };
  }

  function sharedSnapshotFromState(state) {
    state = state || {};
    return {
      protocolVersion: Core.PROTOCOL_VERSION,
      schemaVersion: '3.0.0',
      meta: {
        initialized: true,
        serverSeq: Number(state.meta && (state.meta.serverSeq || state.meta.lastServerRevision) || 0),
        locationsVersion: Number(state.meta && (state.meta.locationsVersion || state.meta.structureVersion) || 0),
        categoriesVersion: Number(state.meta && (state.meta.categoriesVersion || state.meta.categoryVersion) || 0),
        householdSettingsVersion: Number(state.meta && state.meta.householdSettingsVersion || 0)
      },
      segments: clone(state.segments || {}),
      coordinates: clone(state.coordinates || {}),
      spatialBackgroundImage: state.spatialBackgroundImage || null,
      categories: clone(state.categories || {}),
      inventory: clone(state.inventory || []),
      users: clone(state.users || ['Default']),
      userEmails: clone(state.userEmails || {}),
      reminderDays: Number(state.reminderDays || 30)
    };
  }

  function getCanonicalSnapshot() {
    var endpoint = currentEndpoint();
    return endpoint && _canonicalByEndpoint[endpoint] ? clone(_canonicalByEndpoint[endpoint]) : null;
  }

  function putCanonicalSnapshot(snapshot) {
    var endpoint = currentEndpoint();
    if (!endpoint || !snapshot) return Promise.resolve();
    _canonicalByEndpoint[endpoint] = clone(snapshot);
    _cloudInitialized = true;
    _lastSuccessfulEndpoint = endpoint;
    localStorage.setItem(LEGACY_INITIALIZED_KEY, endpoint);
    return persistCanonicalMap();
  }

  function getLocalBaseline() {
    var key = currentScope();
    return _baselineByEndpoint[key] ? clone(_baselineByEndpoint[key]) : null;
  }

  function putLocalBaseline(snapshot) {
    _baselineByEndpoint[currentScope()] = clone(snapshot);
    return persistBaselineMap();
  }

  function clearLocalBaseline() {
    delete _baselineByEndpoint[currentScope()];
    return persistBaselineMap().catch(function() {});
  }

  function ensureLocalBaseline(previousState) {
    var baseline = getLocalBaseline();
    if (baseline) return Promise.resolve(baseline);
    baseline = previousState ? sharedSnapshotFromState(previousState) : emptySharedSnapshot();
    return putLocalBaseline(baseline).then(function() { return clone(baseline); });
  }

  function preserveLocalFields(snapshot) {
    var old = typeof appState !== 'undefined' ? appState : {};
    var next = clone(snapshot || emptySharedSnapshot());
    next.meta = next.meta || {};
    next.meta.deviceId = old.meta && old.meta.deviceId || getDeviceId();
    next.meta.lastSyncedAt = new Date().toISOString();
    next.meta.lastServerRevision = Number(next.meta.serverSeq || 0);
    next.meta.structureVersion = Number(next.meta.locationsVersion || 0);
    next.meta.categoryVersion = Number(next.meta.categoriesVersion || 0);
    next.currentUser = old.currentUser || 'Default';
    next.language = old.language || 'en';
    next.selectedCategoryNodePath = clone(old.selectedCategoryNodePath || null);
    next.activeMappingNode = clone(old.activeMappingNode || null);
    next.reminderLog = clone(old.reminderLog || {});
    next.syncQueue = [];
    next.syncConflicts = [];
    return next;
  }

  function isSharedDataEmpty(state) {
    state = state || {};
    return !(state.inventory && state.inventory.length) && Object.keys(state.segments || {}).length === 0 && Object.keys(state.categories || {}).length === 0;
  }

  function comparableSnapshot(state) {
    var value = sharedSnapshotFromState(state);
    delete value.meta;
    function clean(object) {
      if (Array.isArray(object)) return object.map(clean);
      if (!object || typeof object !== 'object') return object;
      var out = {};
      Object.keys(object).sort().forEach(function(key) {
        if (['version', 'createdAt', 'updatedAt', 'lastModifiedBy', 'timestamp'].indexOf(key) >= 0) return;
        out[key] = clean(object[key]);
      });
      return out;
    }
    return clean(value);
  }

  function localMatchesRemoteWithoutBaseline(remote) {
    return Core.stableStringify(comparableSnapshot(appState)) === Core.stableStringify(comparableSnapshot(remote));
  }

  function enqueueSyncTask(task) {
    _syncQueue = _syncQueue.catch(function() {}).then(function() {
      _taskDepth += 1;
      return Promise.resolve().then(task).finally(function() { _taskDepth -= 1; });
    });
    return _syncQueue;
  }

  function requestV3(action, payload) {
    var endpoint = currentEndpoint();
    var token = localStorage.getItem('sys_api_pwd');
    if (!endpoint) return Promise.reject(new Error('No cloud endpoint configured.'));
    if (!token) return Promise.reject(new Error('No API token configured.'));
    var params = new URLSearchParams();
    params.append('token', token);
    params.append('action', action);
    params.append('protocolVersion', String(Core.PROTOCOL_VERSION));
    params.append('payload', JSON.stringify(payload || {}));
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function() { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(endpoint, { method: 'POST', body: params, signal: controller && controller.signal }).then(function(response) {
      return response.text();
    }).then(function(text) {
      var result;
      try { result = JSON.parse(text); } catch (e) { throw new Error('Invalid server response.'); }
      if (!result || !result.success) {
        var error = new Error(result && (result.message || result.errorCode) || 'Synchronization failed.');
        error.code = result && result.errorCode;
        error.retryable = !!(result && result.retryable);
        error.response = result;
        throw error;
      }
      return result;
    }).catch(function(error) {
      if (error && error.name === 'AbortError') {
        var timeout = new Error('Synchronization request timed out.');
        timeout.code = 'NETWORK_TIMEOUT';
        timeout.retryable = true;
        throw timeout;
      }
      throw error;
    }).finally(function() { if (timer) clearTimeout(timer); });
  }

  function ensureEndpointScope() {
    return _storageReady.then(function() {
      var endpoint = currentEndpoint();
      var scope = currentScope();
      var changed = false;
      if (endpoint && _baselineByEndpoint[LOCAL_SCOPE] && !_baselineByEndpoint[endpoint]) {
        _baselineByEndpoint[endpoint] = _baselineByEndpoint[LOCAL_SCOPE];
        delete _baselineByEndpoint[LOCAL_SCOPE];
        changed = true;
      }
      return idbGetOutboxOps().then(function(ops) {
        var writes = [];
        (ops || []).forEach(function(op) {
          if (!op.syncEndpoint || op.syncEndpoint === LOCAL_SCOPE) {
            op.syncEndpoint = scope;
            writes.push(idbPutOutboxOp(op));
          }
        });
        if (changed) writes.push(persistBaselineMap());
        return Promise.all(writes).then(function() { return ops || []; });
      });
    });
  }

  function compareEntryMetadata(a, b) {
    function clean(entry) {
      entry = clone(entry || {});
      ['quantity', 'version', 'createdAt', 'updatedAt', 'hiddenAt'].forEach(function(key) { delete entry[key]; });
      return Core.stableStringify(entry);
    }
    return clean(a) === clean(b);
  }

  function compareItemMetadata(a, b) {
    function clean(item) {
      item = clone(item || {});
      ['quantity', 'stockEntries', 'version', 'createdAt', 'updatedAt', 'deletedAt', 'lastModifiedBy', 'timestamp'].forEach(function(key) { delete item[key]; });
      return Core.stableStringify(item);
    }
    return clean(a) === clean(b);
  }

  function buildDocumentOperation(type, currentState, projectedBefore, existingOps, deviceId) {
    var dependency;
    if (type === Core.OP_TYPES.LOCATIONS_PUT) {
      dependency = Core.latestDependency(existingOps, 'locations', 'locations');
      return Core.locationsPut(currentState, Number(projectedBefore.meta && projectedBefore.meta.locationsVersion || 0), deviceId, dependency && dependency.opId);
    }
    if (type === Core.OP_TYPES.CATEGORIES_PUT) {
      dependency = Core.latestDependency(existingOps, 'categories', 'categories');
      return Core.categoriesPut(currentState, Number(projectedBefore.meta && projectedBefore.meta.categoriesVersion || 0), deviceId, dependency && dependency.opId);
    }
    dependency = Core.latestDependency(existingOps, 'householdSettings', 'householdSettings');
    return Core.householdSettingsPut(currentState, Number(projectedBefore.meta && projectedBefore.meta.householdSettingsVersion || 0), deviceId, dependency && dependency.opId);
  }

  function buildItemDiffOperations(actionType, metadata, currentState, existingOps, projectedBefore, deviceId) {
    var itemId = metadata && metadata.itemId;
    var currentItem = Core.findItem(currentState, itemId);
    var previousItem = Core.findItem(projectedBefore, itemId);
    var generated = [];
    var workingOps = existingOps.slice();
    var itemDependency = Core.latestItemDependency(workingOps, itemId);
    if (actionType === 'REMOVE_ITEM') {
      if (previousItem) generated.push(Core.itemDelete(itemId, Number(previousItem.version || 0), deviceId, itemDependency && itemDependency.opId));
      return generated;
    }
    if (!currentItem) return generated;
    var itemOperation = null;
    if (!previousItem || !compareItemMetadata(previousItem, currentItem)) {
      itemOperation = Core.itemPut(currentItem, previousItem ? Number(previousItem.version || 0) : 0, deviceId, itemDependency && itemDependency.opId);
      generated.push(itemOperation);
      workingOps.push(itemOperation);
    }
    if (currentItem.itemType !== 'stock') return generated;
    var oldEntries = {};
    var newEntries = {};
    ((previousItem && previousItem.stockEntries) || []).forEach(function(entry) { oldEntries[entry.id] = entry; });
    (currentItem.stockEntries || []).forEach(function(entry) { newEntries[entry.id] = entry; });
    Object.keys(oldEntries).forEach(function(entryId) {
      if (!newEntries[entryId] || newEntries[entryId].hiddenAt) {
        var oldEntry = oldEntries[entryId];
        var dependency = Core.latestDependency(workingOps, 'stockEntry', entryId);
        var operation = Core.stockEntryDelete(itemId, entryId, Number(oldEntry.version || 0), deviceId, dependency && dependency.opId);
        generated.push(operation);
        workingOps.push(operation);
      }
    });
    Object.keys(newEntries).forEach(function(entryId) {
      var nextEntry = newEntries[entryId];
      if (nextEntry.hiddenAt) return;
      var oldEntry = oldEntries[entryId];
      var dependency = Core.latestDependency(workingOps, 'stockEntry', entryId);
      if (!oldEntry) {
        var parentDependency = itemOperation && itemOperation.opId || itemDependency && itemDependency.opId || null;
        var createOperation = Core.stockEntryPut(itemId, nextEntry, 0, Number(nextEntry.quantity || 0), deviceId, parentDependency);
        generated.push(createOperation);
        workingOps.push(createOperation);
        return;
      }
      if (!compareEntryMetadata(oldEntry, nextEntry)) {
        var putOperation = Core.stockEntryPut(itemId, nextEntry, Number(oldEntry.version || 0), 0, deviceId, dependency && dependency.opId);
        generated.push(putOperation);
        workingOps.push(putOperation);
        dependency = putOperation;
      }
      var delta = Number(nextEntry.quantity || 0) - Number(oldEntry.quantity || 0);
      if (delta !== 0) {
        var adjustOperation = Core.stockAdjust(itemId, entryId, delta, deviceId, dependency && dependency.opId);
        generated.push(adjustOperation);
        workingOps.push(adjustOperation);
      }
    });
    return generated;
  }

  function queueMutation(actionType, metadata, currentState, previousPersistedState) {
    return ensureEndpointScope().then(function(allOps) {
      var scope = currentScope();
      var scopedOps = (allOps || []).filter(function(op) { return op.syncEndpoint === scope; });
      var canonical = getCanonicalSnapshot();
      var baselinePromise = canonical ? Promise.resolve(canonical) : ensureLocalBaseline(previousPersistedState);
      return baselinePromise.then(function(baseline) {
        var projectedBefore = Core.projectState(baseline, scopedOps);
        var deviceId = currentState.meta && currentState.meta.deviceId || getDeviceId();
        var generated = [];
        var locationActions = ['ADD_SEGMENT', 'RENAME_SEGMENT', 'DELETE_SEGMENT', 'ADD_CONTAINER', 'RENAME_CONTAINER', 'DELETE_CONTAINER', 'ADD_SUBCONTAINER', 'ADD_SUB_CONTAINER', 'RENAME_SUBCONTAINER', 'RENAME_SUB_CONTAINER', 'DELETE_SUBCONTAINER', 'DELETE_SUB_CONTAINER', 'SAVE_LAYOUT', 'UPDATE_COORDINATE', 'UPDATE_BACKGROUND_IMAGE'];
        var categoryActions = ['ADD_CATEGORY', 'DELETE_CATEGORY', 'SAVE_CLASSIFICATION'];
        var settingsActions = ['ADD_USER', 'REMOVE_USER', 'SET_REMINDER'];
        if (locationActions.indexOf(actionType) >= 0) generated = [buildDocumentOperation(Core.OP_TYPES.LOCATIONS_PUT, currentState, projectedBefore, scopedOps, deviceId)];
        else if (categoryActions.indexOf(actionType) >= 0) generated = [buildDocumentOperation(Core.OP_TYPES.CATEGORIES_PUT, currentState, projectedBefore, scopedOps, deviceId)];
        else if (settingsActions.indexOf(actionType) >= 0) generated = [buildDocumentOperation(Core.OP_TYPES.HOUSEHOLD_SETTINGS_PUT, currentState, projectedBefore, scopedOps, deviceId)];
        else if (['COMMIT_ITEM', 'EDIT_ITEM', 'REMOVE_ITEM', 'STOCK_IN', 'STOCK_OUT'].indexOf(actionType) >= 0) generated = buildItemDiffOperations(actionType, metadata || {}, currentState, scopedOps, projectedBefore, deviceId);
        generated.forEach(function(op) { op.syncEndpoint = scope; });
        return Core.sortOperations(generated);
      });
    });
  }

  function persistStateAndOperationsAtomically(state, operations) {
    return openStateDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(['appState', 'outbox'], 'readwrite');
        tx.objectStore('appState').put({ key: 'canonical', value: buildPersistedStateSnapshot(state) });
        (operations || []).forEach(function(op) { tx.objectStore('outbox').put(op); });
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
        tx.onabort = function() { reject(tx.error || new Error('State/outbox transaction aborted.')); };
      });
    });
  }

  window.mutateState = function(actionType, metadata) {
    appState.meta = appState.meta || {};
    appState.meta.deviceId = appState.meta.deviceId || getDeviceId();
    appState.meta.lastLocalChangeAt = new Date().toISOString();
    appState.meta.lastChangeBy = appState.meta.deviceId;
    saveStateToLocalStorage();
    var currentState = clone(appState);
    _mutationQueue = _mutationQueue.catch(function() {}).then(function() {
      return idbGetAppState().catch(function() { return null; }).then(function(previousState) {
        if (actionType === 'SWITCH_USER' || actionType === 'SWITCH_LANGUAGE') return persistStateAndOperationsAtomically(currentState, []).then(function() { return []; });
        return queueMutation(actionType, metadata || {}, currentState, previousState).then(function(generated) {
          return persistStateAndOperationsAtomically(currentState, generated).then(function() { return generated; });
        });
      }).then(function(generated) {
        updatePillSyncStatus();
        updateSyncStatusBadge();
        if (generated.length && navigator.onLine) return window.flushOutbox();
      });
    }).catch(function(error) {
      _syncLastFailed = true;
      console.error('[SyncV3] Failed to persist mutation:', error);
      showToast('Local save failed: ' + error.message, 'error');
      updatePillSyncStatus();
      updateSyncStatusBadge();
    });
    return _mutationQueue;
  };

  function scopedOperations(ops) {
    var scope = currentScope();
    return (ops || []).filter(function(op) { return op.syncEndpoint === scope; });
  }

  function problemOperations(ops) {
    var endpoint = currentScope();
    return (ops || []).filter(function(op) { return op.syncEndpoint !== endpoint || ['conflict', 'rejected', 'blocked'].indexOf(op.status) >= 0; });
  }

  function applyCanonicalAndProject(snapshot) {
    return putCanonicalSnapshot(snapshot).then(clearLocalBaseline).then(idbGetOutboxOps).then(function(ops) {
      var projected = Core.projectState(snapshot, scopedOperations(ops));
      var next = preserveLocalFields(projected);
      next.syncConflicts = problemOperations(ops).map(function(op) { return op.lastResult || op; });
      appState = next;
      window.appState = appState;
      normalizeAllItemImageFields();
      saveStateToLocalStorage();
      return idbPutAppState(buildPersistedStateSnapshot(appState)).then(function() {
        syncUIComponents(); updatePillSyncStatus(); updateSyncStatusBadge(); updateLoginSyncStatus();
      });
    });
  }

  function setOutboxStatus(op, status, result) {
    op.status = status;
    op.lastResult = clone(result || {});
    op.updatedAt = new Date().toISOString();
    return idbPutOutboxOp(op);
  }

  function processPushResults(submitted, result) {
    var returned = {};
    (result.results || []).forEach(function(item) { if (item && item.opId) returned[item.opId] = item; });
    return submitted.reduce(function(chain, op) {
      return chain.then(function() {
        var opResult = returned[op.opId];
        var action = Core.operationResultAction(opResult);
        if (action === 'delete') return idbDeleteOutboxOp(op.opId);
        return setOutboxStatus(op, action, opResult || { errorCode: 'MISSING_OPERATION_RESULT' });
      });
    }, Promise.resolve()).then(function() {
      _syncConflict = (result.results || []).some(function(item) { return ['conflict', 'rejected', 'blocked'].indexOf(item.status) >= 0; });
      if (!result.snapshot || result.snapshot.protocolVersion !== Core.PROTOCOL_VERSION) throw new Error('Server returned an invalid canonical snapshot.');
      return applyCanonicalAndProject(result.snapshot);
    });
  }

  function flushOutboxRaw() {
    var endpoint = currentEndpoint();
    var token = localStorage.getItem('sys_api_pwd');
    if (!endpoint || !token || !_cloudInitialized || _protocolError || _outboxFlushInProgress) return Promise.resolve();
    _outboxFlushInProgress = true;
    _syncLastFailed = false;
    updatePillSyncStatus(); updateSyncStatusBadge();
    var processed = {};
    function drain() {
      return ensureEndpointScope().then(function(ops) {
        var batch = Core.selectPushBatch(ops, currentScope(), processed, MAX_PUSH_OPERATIONS);
        if (!batch.length) return;
        batch.forEach(function(op) { processed[op.opId] = true; op.attemptedAt = new Date().toISOString(); });
        return Promise.all(batch.map(idbPutOutboxOp)).then(function() {
          return requestV3('SYNC_PUSH', {
            deviceId: getDeviceId(), requestId: 'req_' + Date.now().toString(36),
            operations: batch.map(function(op) {
              var copy = clone(op);
              delete copy.status; delete copy.lastResult; delete copy.updatedAt; delete copy.attemptedAt; delete copy.syncEndpoint;
              return copy;
            })
          });
        }).then(function(result) { return processPushResults(batch, result); }).then(drain);
      });
    }
    return drain().catch(function(error) {
      if (error.code === 'PROTOCOL_VERSION_MISMATCH') _protocolError = true;
      _syncLastFailed = true;
      console.error('[SyncV3] Push failed:', error);
      throw error;
    }).finally(function() {
      _outboxFlushInProgress = false;
      updatePillSyncStatus(); updateSyncStatusBadge(); updateLoginSyncStatus();
    });
  }

  window.flushOutbox = function() { return _taskDepth > 0 ? flushOutboxRaw() : enqueueSyncTask(flushOutboxRaw); };

  function clearCurrentEndpointOutbox() {
    var scope = currentScope();
    return idbGetOutboxOps().then(function(ops) {
      return Promise.all((ops || []).filter(function(op) { return op.syncEndpoint === scope; }).map(function(op) { return idbDeleteOutboxOp(op.opId); }));
    });
  }

  function bootstrapCloudRaw() {
    return requestV3('SYNC_BOOTSTRAP', {
      deviceId: getDeviceId(), requestId: 'req_' + Date.now().toString(36), expectedServerSeq: 0,
      snapshot: sharedSnapshotFromState(appState)
    }).then(function(result) {
      return clearCurrentEndpointOutbox().then(function() { return applyCanonicalAndProject(result.snapshot); });
    });
  }

  function pullCloudRaw() {
    var endpoint = currentEndpoint();
    if (!endpoint || _syncInProgress) return Promise.resolve();
    _syncInProgress = true;
    _syncLastFailed = false;
    _syncConflict = false;
    showLoadingCloudOverlay(); updatePillSyncStatus();
    var keptLocal = false;
    return ensureEndpointScope().then(function() {
      return requestV3('SYNC_PULL', { deviceId: getDeviceId(), requestId: 'req_' + Date.now().toString(36), includeDeleted: true });
    }).then(function(result) {
      if (!result.initialized) {
        _cloudInitialized = false;
        if (isSharedDataEmpty(appState)) {
          if (window.confirm('Cloud storage is empty. Initialize it for this household?')) return bootstrapCloudRaw();
          return;
        }
        if (window.confirm('Cloud storage is empty. Upload this device\'s inventory to initialize multi-device sync?\n\nChoose Cancel to keep working locally.')) return bootstrapCloudRaw();
        showToast('Cloud not initialized. Changes remain saved locally.', 'info');
        return;
      }
      var canonical = getCanonicalSnapshot();
      if (!canonical) {
        var matches = localMatchesRemoteWithoutBaseline(result.snapshot);
        if (!isSharedDataEmpty(appState) && !matches) {
          var replace = window.confirm('This device contains local data but has no trusted synchronization baseline for this cloud.\n\nChoose OK to replace this device with the cloud copy. Choose Cancel to keep the local copy unchanged.');
          if (!replace) {
            keptLocal = true;
            _cloudInitialized = false;
            showOfflineBanner('Local data kept. Export or reconcile it before enabling this cloud.');
            return;
          }
        }
        return clearCurrentEndpointOutbox().then(function() {
          _cloudInitialized = true;
          return applyCanonicalAndProject(result.snapshot);
        });
      }
      _cloudInitialized = true;
      return applyCanonicalAndProject(result.snapshot).then(flushOutboxRaw);
    }).then(function() { if (!keptLocal) hideOfflineBanner(); }).catch(function(error) {
      if (error.code === 'PROTOCOL_VERSION_MISMATCH') {
        _protocolError = true;
        showOfflineBanner('Cloud sync update required: protocol version mismatch.');
      } else {
        _syncLastFailed = true;
        showOfflineBanner(error.message || 'Cannot reach cloud');
      }
      console.error('[SyncV3] Pull failed:', error);
      throw error;
    }).finally(function() {
      _syncInProgress = false;
      hideLoadingCloudOverlay(); updatePillSyncStatus(); updateSyncStatusBadge(); updateLoginSyncStatus(); syncUIComponents();
    });
  }

  window.bootSyncManager = function() { return enqueueSyncTask(pullCloudRaw).catch(function() {}); };
  window.startupLoadFromCloud = window.bootSyncManager;
  window.syncDataEngine = function(interactive) { return window.bootSyncManager().then(function() { if (interactive) showToast('Synchronization complete.', 'success'); }); };
  window.syncNow = function(opts) { opts = opts || {}; if (opts.interactive !== false) showToast('Syncing...', 'info'); return window.bootSyncManager(); };
  window.triggerSynchronousCloudFetchPull = window.bootSyncManager;
  window.triggerAutoCloudSyncIfPossible = function() { setTimeout(window.bootSyncManager, 300); };
  window.autoPullFromCloudIfPossible = window.bootSyncManager;
  window.getCloudState = function() {
    return requestV3('SYNC_PULL', { deviceId: getDeviceId(), requestId: 'req_' + Date.now().toString(36), includeDeleted: true })
      .then(function(result) { return result.initialized ? result.snapshot : null; });
  };

  window.verifyCloudSync = function() {
    return requestV3('SYNC_PULL', { deviceId: getDeviceId(), requestId: 'verify_' + Date.now().toString(36), includeDeleted: true }).then(function(result) {
      if (!result.initialized) throw new Error('Cloud is not initialized.');
      return idbGetOutboxOps().then(function(ops) {
        var scoped = scopedOperations(ops);
        if (!scoped.length && Core.stableStringify(comparableSnapshot(appState)) === Core.stableStringify(comparableSnapshot(result.snapshot))) showToast('✅ In sync — revision ' + result.serverSeq, 'success');
        else showToast('⚠️ Sync review needed — ' + scoped.length + ' local operation(s) remain.', 'error');
      });
    }).catch(function(error) {
      _syncLastFailed = true; updateSyncStatusBadge(); showToast('Sync verification failed: ' + error.message, 'error');
    });
  };

  function deleteOperationIds(ids) {
    return ids.reduce(function(chain, id) { return chain.then(function() { return idbDeleteOutboxOp(id); }); }, Promise.resolve());
  }

  function removeConflictPanel() {
    if (_conflictPanel && _conflictPanel.parentNode) _conflictPanel.parentNode.removeChild(_conflictPanel);
    _conflictPanel = null;
  }

  function discardOperationTree(rootId) {
    return idbGetOutboxOps().then(function(ops) { return deleteOperationIds(Core.descendantIds(ops, rootId)); }).then(function() {
      removeConflictPanel();
      var canonical = getCanonicalSnapshot();
      if (canonical) return applyCanonicalAndProject(canonical);
    });
  }

  function regenerateConflictTree(rootOperation) {
    var canonical = getCanonicalSnapshot();
    if (!canonical) return Promise.reject(new Error('No canonical cloud snapshot is available.'));
    return idbGetOutboxOps().then(function(allOps) {
      var scopeOps = scopedOperations(allOps);
      var desired = Core.projectState(canonical, scopeOps);
      var treeIds = Core.descendantIds(scopeOps, rootOperation.opId);
      var treeMap = {};
      treeIds.forEach(function(id) { treeMap[id] = true; });
      var remaining = scopeOps.filter(function(op) { return !treeMap[op.opId]; });
      var before = Core.projectState(canonical, remaining);
      var generated = [];
      var itemId = rootOperation.entityType === 'item' ? rootOperation.entityId : rootOperation.payload && rootOperation.payload.itemId;
      var deviceId = getDeviceId();
      if (itemId) {
        var desiredItem = Core.findItem(desired, itemId);
        generated = buildItemDiffOperations(desiredItem && desiredItem.deletedAt ? 'REMOVE_ITEM' : 'EDIT_ITEM', { itemId: itemId }, desired, remaining, before, deviceId);
      } else if (rootOperation.type === Core.OP_TYPES.LOCATIONS_PUT) generated = [buildDocumentOperation(Core.OP_TYPES.LOCATIONS_PUT, desired, before, remaining, deviceId)];
      else if (rootOperation.type === Core.OP_TYPES.CATEGORIES_PUT) generated = [buildDocumentOperation(Core.OP_TYPES.CATEGORIES_PUT, desired, before, remaining, deviceId)];
      else if (rootOperation.type === Core.OP_TYPES.HOUSEHOLD_SETTINGS_PUT) generated = [buildDocumentOperation(Core.OP_TYPES.HOUSEHOLD_SETTINGS_PUT, desired, before, remaining, deviceId)];
      generated.forEach(function(op) { op.syncEndpoint = currentScope(); });
      if (!generated.length) throw new Error('This conflict cannot be reapplied automatically.');
      return deleteOperationIds(treeIds).then(function() {
        return generated.reduce(function(chain, op) { return chain.then(function() { return idbPutOutboxOp(op); }); }, Promise.resolve());
      });
    }).then(function() {
      removeConflictPanel();
      return applyCanonicalAndProject(canonical).then(flushOutboxRaw);
    });
  }

  function showConflictDetails(op, isOrphaned) {
    window.alert(JSON.stringify({
      operation: { type: op.type, entityId: op.entityId, baseVersion: op.baseVersion, dependsOnOpId: op.dependsOnOpId, syncEndpoint: op.syncEndpoint, payload: op.payload },
      status: isOrphaned ? 'orphaned_endpoint' : op.status,
      serverResult: op.lastResult || null
    }, null, 2));
  }

  function makeButton(text, background, color) {
    var button = document.createElement('button');
    button.textContent = text;
    button.style.cssText = 'padding:6px 10px;border-radius:7px;border:1px solid #cbd5e1;background:' + background + ';color:' + color + ';font-size:12px';
    return button;
  }

  function openConflictPanel() {
    idbGetOutboxOps().then(function(ops) {
      var current = currentScope();
      var problems = (ops || []).filter(function(op) { return op.syncEndpoint !== current || ['conflict', 'rejected', 'blocked'].indexOf(op.status) >= 0; });
      if (!problems.length) return;
      removeConflictPanel();
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.65);display:flex;align-items:center;justify-content:center;padding:16px';
      var panel = document.createElement('div');
      panel.style.cssText = 'background:white;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:760px;width:100%;max-height:85vh;overflow:auto;padding:20px';
      var header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px';
      var title = document.createElement('h2');
      title.textContent = 'Synchronization problems'; title.style.cssText = 'font-size:18px;font-weight:700';
      var close = makeButton('×', 'white', '#475569'); close.onclick = removeConflictPanel;
      header.appendChild(title); header.appendChild(close); panel.appendChild(header);
      problems.forEach(function(op) {
        var isOrphaned = op.syncEndpoint !== current;
        var result = op.lastResult || {};
        var row = document.createElement('div'); row.style.cssText = 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:10px';
        var name = document.createElement('div'); name.textContent = String(op.type || 'Operation') + ' — ' + String(op.entityId || ''); name.style.cssText = 'font-weight:700;font-size:13px';
        var reason = document.createElement('div'); reason.textContent = isOrphaned ? 'Saved for a different cloud endpoint' : String(result.errorCode || op.status || 'problem'); reason.style.cssText = 'font-size:12px;color:#64748b;margin:4px 0 10px';
        var actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
        var discard = makeButton(isOrphaned ? 'Discard operation' : 'Use cloud / discard local tree', '#e2e8f0', '#334155'); discard.onclick = function() { discardOperationTree(op.opId); }; actions.appendChild(discard);
        if (!isOrphaned && op.status === 'conflict' && result.errorCode !== 'ENTITY_DELETED') {
          var keep = makeButton('Keep my latest version', '#2563eb', 'white');
          keep.onclick = function() { regenerateConflictTree(op).catch(function(error) { showToast(error.message, 'error'); }); };
          actions.appendChild(keep);
        }
        var detail = makeButton('Review details', '#f8fafc', '#334155'); detail.onclick = function() { showConflictDetails(op, isOrphaned); }; actions.appendChild(detail);
        row.appendChild(name); row.appendChild(reason); row.appendChild(actions); panel.appendChild(row);
      });
      overlay.appendChild(panel);
      overlay.onclick = function(event) { if (event.target === overlay) removeConflictPanel(); };
      document.body.appendChild(overlay); _conflictPanel = overlay;
    });
  }

  var legacyUpdatePill = window.updatePillSyncStatus;
  window.updatePillSyncStatus = function() {
    if (_protocolError) {
      ['syncStatusPill', 'syncStatusPillMobile'].forEach(function(id) {
        var pill = document.getElementById(id);
        if (pill) { pill.className = 'sync-pill pill-conflict'; pill.textContent = 'Update required'; }
      });
      return;
    }
    var result = legacyUpdatePill ? legacyUpdatePill.apply(this, arguments) : undefined;
    setTimeout(function() {
      idbGetOutboxOps().then(function(ops) {
        var current = currentScope();
        var problems = (ops || []).filter(function(op) { return op.syncEndpoint !== current || ['conflict', 'rejected', 'blocked'].indexOf(op.status) >= 0; });
        var pending = (ops || []).filter(function(op) { return op.syncEndpoint === current && ['pending', 'retry'].indexOf(op.status || 'pending') >= 0; });
        ['syncStatusPill', 'syncStatusPillMobile'].forEach(function(id) {
          var pill = document.getElementById(id);
          if (!pill) return;
          if (problems.length) { pill.className = 'sync-pill pill-conflict'; pill.textContent = '⚠ Needs review'; pill.onclick = openConflictPanel; }
          else if (pending.length) { pill.className = 'sync-pill pill-pending'; pill.textContent = pending.length + ' changes waiting'; pill.onclick = window.bootSyncManager; }
          else if (!_syncInProgress && !_outboxFlushInProgress && !_syncLastFailed && _lastSuccessfulEndpoint === currentEndpoint()) { pill.className = 'sync-pill pill-synced'; pill.textContent = '✔ Synced'; pill.onclick = window.bootSyncManager; }
        });
      }).catch(function() {});
    }, 0);
    return result;
  };

  console.log('[SyncV3] Protocol v3 browser integration loaded.');
})();
