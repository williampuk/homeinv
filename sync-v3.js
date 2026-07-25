(function() {
  'use strict';

  if (!window.SyncV3Core) {
    console.error('[SyncV3] sync-v3-core.js was not loaded.');
    return;
  }

  var Core = window.SyncV3Core;
  var CANONICAL_KEY = 'fmi_sync_v3_canonical';
  var CLOUD_INITIALIZED_KEY = 'fmi_sync_v3_initialized';
  var _syncV3Serial = Promise.resolve();
  var _syncV3ProtocolError = false;
  var _syncV3CloudInitialized = localStorage.getItem(CLOUD_INITIALIZED_KEY) === '1';

  function clone(value) { return Core.clone(value); }

  function getCanonicalSnapshot() {
    try {
      var raw = localStorage.getItem(CANONICAL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('[SyncV3] Invalid canonical cache:', e);
      return null;
    }
  }

  function putCanonicalSnapshot(snapshot) {
    if (!snapshot) return;
    localStorage.setItem(CANONICAL_KEY, JSON.stringify(snapshot));
    localStorage.setItem(CLOUD_INITIALIZED_KEY, '1');
    _syncV3CloudInitialized = true;
  }

  function sharedSnapshotFromState(state) {
    state = state || {};
    return {
      protocolVersion: Core.PROTOCOL_VERSION,
      schemaVersion: '3.0.0',
      meta: {
        initialized: true,
        serverSeq: Number(state.meta && state.meta.serverSeq || state.meta && state.meta.lastServerRevision || 0),
        locationsVersion: Number(state.meta && state.meta.locationsVersion || state.meta && state.meta.structureVersion || 0),
        categoriesVersion: Number(state.meta && state.meta.categoriesVersion || state.meta && state.meta.categoryVersion || 0),
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

  function preserveLocalFields(snapshot) {
    var old = window.appState || appState || {};
    var projected = clone(snapshot || {});
    projected.meta = projected.meta || {};
    projected.meta.deviceId = old.meta && old.meta.deviceId || getDeviceId();
    projected.meta.lastSyncedAt = new Date().toISOString();
    projected.meta.lastServerRevision = Number(snapshot && snapshot.meta && snapshot.meta.serverSeq || 0);
    projected.meta.structureVersion = Number(snapshot && snapshot.meta && snapshot.meta.locationsVersion || 0);
    projected.meta.categoryVersion = Number(snapshot && snapshot.meta && snapshot.meta.categoriesVersion || 0);
    projected.currentUser = old.currentUser || 'Default';
    projected.language = old.language || 'en';
    projected.selectedCategoryNodePath = clone(old.selectedCategoryNodePath || null);
    projected.activeMappingNode = clone(old.activeMappingNode || null);
    projected.reminderLog = clone(old.reminderLog || {});
    projected.syncQueue = [];
    projected.syncConflicts = clone(old.syncConflicts || []);
    return projected;
  }

  function isSharedDataEmpty(state) {
    state = state || {};
    return !(state.inventory && state.inventory.length) &&
      Object.keys(state.segments || {}).length === 0 &&
      Object.keys(state.categories || {}).length === 0;
  }

  function postV3(action, payload) {
    var endpoint = localStorage.getItem('sys_gas_url');
    var token = localStorage.getItem('sys_api_pwd');
    if (!endpoint) return Promise.reject(new Error('No cloud endpoint configured.'));
    if (!token) return Promise.reject(new Error('No API token configured.'));
    var params = new URLSearchParams();
    params.append('token', token);
    params.append('action', action);
    params.append('protocolVersion', String(Core.PROTOCOL_VERSION));
    params.append('payload', JSON.stringify(payload || {}));
    return fetch(endpoint, { method: 'POST', body: params }).then(function(resp) {
      return resp.text().then(function(text) {
        var json;
        try { json = JSON.parse(text); }
        catch (e) { throw new Error('Invalid server response.'); }
        if (!json.success) {
          var err = new Error(json.message || json.errorCode || 'Sync failed.');
          err.code = json.errorCode;
          err.retryable = !!json.retryable;
          err.response = json;
          throw err;
        }
        return json;
      });
    });
  }

  function setOutboxStatus(op, status, result) {
    op.status = status;
    op.lastResult = clone(result || {});
    op.updatedAt = new Date().toISOString();
    return idbPutOutboxOp(op);
  }

  function compareEntryMetadata(a, b) {
    function clean(entry) {
      entry = clone(entry || {});
      ['quantity', 'version', 'createdAt', 'updatedAt', 'hiddenAt'].forEach(function(k) { delete entry[k]; });
      return entry;
    }
    return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
  }

  function compareItemMetadata(a, b) {
    function clean(item) {
      item = clone(item || {});
      ['quantity', 'stockEntries', 'version', 'createdAt', 'updatedAt', 'deletedAt', 'lastModifiedBy', 'timestamp'].forEach(function(k) { delete item[k]; });
      return item;
    }
    return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
  }

  function enqueueOperation(op) {
    return idbPutOutboxOp(op).then(function() {
      updatePillSyncStatus();
      updateSyncStatusBadge();
      return op;
    });
  }

  function dependencyFor(ops, entityType, entityId) {
    return Core.latestDependency(ops, entityType, entityId);
  }

  function queueDocumentOperation(type, currentState, canonical, ops, deviceId) {
    var entityType;
    var version;
    var dep;
    var op;
    if (type === Core.OP_TYPES.LOCATIONS_PUT) {
      entityType = 'locations';
      dep = dependencyFor(ops, entityType, entityType);
      version = Core.nextBaseVersion(canonical && canonical.meta && canonical.meta.locationsVersion || 0, dep);
      op = Core.locationsPut(currentState, version, deviceId, dep && dep.opId);
    } else if (type === Core.OP_TYPES.CATEGORIES_PUT) {
      entityType = 'categories';
      dep = dependencyFor(ops, entityType, entityType);
      version = Core.nextBaseVersion(canonical && canonical.meta && canonical.meta.categoriesVersion || 0, dep);
      op = Core.categoriesPut(currentState, version, deviceId, dep && dep.opId);
    } else {
      entityType = 'householdSettings';
      dep = dependencyFor(ops, entityType, entityType);
      version = Core.nextBaseVersion(canonical && canonical.meta && canonical.meta.householdSettingsVersion || 0, dep);
      op = Core.householdSettingsPut(currentState, version, deviceId, dep && dep.opId);
    }
    return enqueueOperation(op);
  }

  function queueItemDiff(actionType, metadata, currentState, canonical, existingOps, projectedBefore, deviceId) {
    var itemId = metadata && metadata.itemId;
    var currentItem = Core.findItem(currentState, itemId);
    var previousItem = Core.findItem(projectedBefore, itemId);
    var promises = [];
    var dep;
    var base;

    if (actionType === 'REMOVE_ITEM') {
      dep = dependencyFor(existingOps, 'item', itemId);
      base = Core.nextBaseVersion(previousItem && previousItem.version || 0, dep);
      promises.push(enqueueOperation(Core.itemDelete(itemId, base, deviceId, dep && dep.opId)));
      return Promise.all(promises);
    }

    if (!currentItem) return Promise.resolve([]);

    dep = dependencyFor(existingOps, 'item', itemId);
    base = Core.nextBaseVersion(previousItem && previousItem.version || 0, dep);
    if (!previousItem || !compareItemMetadata(previousItem, currentItem)) {
      var itemOp = Core.itemPut(currentItem, previousItem ? base : 0, deviceId, dep && dep.opId);
      promises.push(enqueueOperation(itemOp));
      existingOps = existingOps.concat([itemOp]);
    }

    if (currentItem.itemType !== 'stock') return Promise.all(promises);

    var oldEntries = {};
    var newEntries = {};
    ((previousItem && previousItem.stockEntries) || []).forEach(function(entry) { oldEntries[entry.id] = entry; });
    (currentItem.stockEntries || []).forEach(function(entry) { newEntries[entry.id] = entry; });

    Object.keys(oldEntries).forEach(function(entryId) {
      if (!newEntries[entryId] || newEntries[entryId].hiddenAt) {
        var oldEntry = oldEntries[entryId];
        var entryDep = dependencyFor(existingOps, 'stockEntry', entryId);
        var entryBase = Core.nextBaseVersion(oldEntry.version || 0, entryDep);
        var deleteOp = Core.stockEntryDelete(itemId, entryId, entryBase, deviceId, entryDep && entryDep.opId);
        promises.push(enqueueOperation(deleteOp));
        existingOps = existingOps.concat([deleteOp]);
      }
    });

    Object.keys(newEntries).forEach(function(entryId) {
      var nextEntry = newEntries[entryId];
      if (nextEntry.hiddenAt) return;
      var oldEntry = oldEntries[entryId];
      var entryDep = dependencyFor(existingOps, 'stockEntry', entryId);
      if (!oldEntry) {
        var createOp = Core.stockEntryPut(itemId, nextEntry, 0, Number(nextEntry.quantity || 0), deviceId, entryDep && entryDep.opId);
        promises.push(enqueueOperation(createOp));
        existingOps = existingOps.concat([createOp]);
        return;
      }
      if (!compareEntryMetadata(oldEntry, nextEntry)) {
        var entryBase = Core.nextBaseVersion(oldEntry.version || 0, entryDep);
        var putOp = Core.stockEntryPut(itemId, nextEntry, entryBase, 0, deviceId, entryDep && entryDep.opId);
        promises.push(enqueueOperation(putOp));
        existingOps = existingOps.concat([putOp]);
        entryDep = putOp;
      }
      var delta = Number(nextEntry.quantity || 0) - Number(oldEntry.quantity || 0);
      if (delta !== 0) {
        var adjustOp = Core.stockAdjust(itemId, entryId, delta, deviceId, entryDep && entryDep.opId);
        promises.push(enqueueOperation(adjustOp));
        existingOps = existingOps.concat([adjustOp]);
      }
    });

    return Promise.all(promises);
  }

  function queueMutation(actionType, metadata, currentState) {
    return Promise.all([idbGetOutboxOps(), Promise.resolve(getCanonicalSnapshot())]).then(function(values) {
      var ops = values[0] || [];
      var canonical = values[1] || sharedSnapshotFromState(currentState);
      var projectedBefore = Core.projectState(canonical, ops);
      var deviceId = currentState.meta && currentState.meta.deviceId || getDeviceId();
      var locationActions = ['ADD_SEGMENT', 'RENAME_SEGMENT', 'DELETE_SEGMENT', 'ADD_CONTAINER', 'RENAME_CONTAINER', 'DELETE_CONTAINER', 'ADD_SUBCONTAINER', 'ADD_SUB_CONTAINER', 'RENAME_SUBCONTAINER', 'RENAME_SUB_CONTAINER', 'DELETE_SUBCONTAINER', 'DELETE_SUB_CONTAINER', 'SAVE_LAYOUT', 'UPDATE_COORDINATE', 'UPDATE_BACKGROUND_IMAGE'];
      var categoryActions = ['ADD_CATEGORY', 'DELETE_CATEGORY', 'SAVE_CLASSIFICATION'];
      var settingActions = ['ADD_USER', 'REMOVE_USER', 'SET_REMINDER'];

      if (locationActions.indexOf(actionType) >= 0) return queueDocumentOperation(Core.OP_TYPES.LOCATIONS_PUT, currentState, canonical, ops, deviceId);
      if (categoryActions.indexOf(actionType) >= 0) return queueDocumentOperation(Core.OP_TYPES.CATEGORIES_PUT, currentState, canonical, ops, deviceId);
      if (settingActions.indexOf(actionType) >= 0) return queueDocumentOperation(Core.OP_TYPES.HOUSEHOLD_SETTINGS_PUT, currentState, canonical, ops, deviceId);
      if (['COMMIT_ITEM', 'EDIT_ITEM', 'REMOVE_ITEM', 'STOCK_IN', 'STOCK_OUT'].indexOf(actionType) >= 0) {
        return queueItemDiff(actionType, metadata || {}, currentState, canonical, ops, projectedBefore, deviceId);
      }
      return Promise.resolve([]);
    });
  }

  window.mutateState = function(actionType, metadata) {
    appState.meta = appState.meta || {};
    appState.meta.deviceId = appState.meta.deviceId || getDeviceId();
    appState.meta.lastLocalChangeAt = new Date().toISOString();
    appState.meta.lastChangeBy = appState.meta.deviceId;
    saveStateToLocalStorage();
    idbPutAppState(buildPersistedStateSnapshot(appState)).catch(function() {});

    if (actionType === 'SWITCH_USER' || actionType === 'SWITCH_LANGUAGE') {
      updatePillSyncStatus();
      updateSyncStatusBadge();
      return;
    }

    queueMutation(actionType, metadata || {}, clone(appState)).then(function() {
      if (navigator.onLine) return window.flushOutbox();
    }).catch(function(err) {
      _syncLastFailed = true;
      console.error('[SyncV3] Failed to queue mutation:', err);
      updatePillSyncStatus();
      updateSyncStatusBadge();
    });
  };

  function applyCanonicalAndProject(snapshot) {
    putCanonicalSnapshot(snapshot);
    return idbGetOutboxOps().then(function(ops) {
      var projectedShared = Core.projectState(snapshot, ops || []);
      var nextState = preserveLocalFields(projectedShared);
      nextState.syncConflicts = (ops || []).filter(function(op) {
        return ['conflict', 'rejected', 'blocked'].indexOf(op.status) >= 0;
      }).map(function(op) { return op.lastResult || op; });
      appState = nextState;
      normalizeAllItemImageFields();
      saveStateToLocalStorage();
      return idbPutAppState(buildPersistedStateSnapshot(appState)).then(function() {
        syncUIComponents();
        updatePillSyncStatus();
        updateSyncStatusBadge();
        updateLoginSyncStatus();
      });
    });
  }

  window.getCloudState = function(secret, endpoint) {
    return postV3('SYNC_PULL', { deviceId: getDeviceId(), requestId: 'req_' + Date.now().toString(36), includeDeleted: true });
  };

  function bootstrapCloud() {
    return postV3('SYNC_BOOTSTRAP', {
      deviceId: getDeviceId(),
      requestId: 'req_' + Date.now().toString(36),
      expectedServerSeq: 0,
      snapshot: sharedSnapshotFromState(appState)
    }).then(function(result) {
      return applyCanonicalAndProject(result.snapshot);
    });
  }

  window.flushOutbox = function() {
    _syncV3Serial = _syncV3Serial.then(function() {
      var endpoint = localStorage.getItem('sys_gas_url');
      var secret = localStorage.getItem('sys_api_pwd');
      if (!endpoint || !secret || !_syncV3CloudInitialized || _syncV3ProtocolError) return;
      if (_outboxFlushInProgress) return;
      _outboxFlushInProgress = true;
      _syncLastFailed = false;
      updatePillSyncStatus();
      updateSyncStatusBadge();

      var submitted = [];
      return idbGetOutboxOps().then(function(ops) {
        submitted = (ops || []).filter(function(op) {
          return ['pending', 'retry'].indexOf(op.status || 'pending') >= 0;
        });
        if (!submitted.length) return null;
        submitted.forEach(function(op) { op.attemptedAt = new Date().toISOString(); });
        return Promise.all(submitted.map(function(op) { return idbPutOutboxOp(op); })).then(function() {
          return postV3('SYNC_PUSH', {
            deviceId: getDeviceId(),
            requestId: 'req_' + Date.now().toString(36),
            operations: submitted.map(function(op) {
              var copy = clone(op);
              delete copy.status; delete copy.lastResult; delete copy.updatedAt; delete copy.attemptedAt;
              return copy;
            })
          });
        });
      }).then(function(result) {
        if (!result) return;
        var byId = {};
        submitted.forEach(function(op) { byId[op.opId] = op; });
        return Promise.all((result.results || []).map(function(opResult) {
          var op = byId[opResult.opId];
          if (!op) return Promise.resolve();
          var action = Core.operationResultAction(opResult);
          if (action === 'delete') return idbDeleteOutboxOp(op.opId);
          return setOutboxStatus(op, action, opResult);
        })).then(function() {
          _syncConflict = (result.results || []).some(function(r) { return ['conflict', 'rejected', 'blocked'].indexOf(r.status) >= 0; });
          return applyCanonicalAndProject(result.snapshot);
        });
      }).catch(function(err) {
        if (err.code === 'PROTOCOL_VERSION_MISMATCH') _syncV3ProtocolError = true;
        _syncLastFailed = true;
        console.error('[SyncV3] Push failed:', err);
        throw err;
      }).finally(function() {
        _outboxFlushInProgress = false;
        updatePillSyncStatus();
        updateSyncStatusBadge();
        updateLoginSyncStatus();
      });
    }).catch(function() {});
    return _syncV3Serial;
  };

  window.bootSyncManager = function(opts) {
    opts = opts || {};
    _syncV3Serial = _syncV3Serial.then(function() {
      var endpoint = localStorage.getItem('sys_gas_url');
      if (!endpoint || _syncInProgress) return;
      _syncInProgress = true;
      _syncLastFailed = false;
      _syncConflict = false;
      showLoadingCloudOverlay();
      updatePillSyncStatus();

      return postV3('SYNC_PULL', { deviceId: getDeviceId(), requestId: 'req_' + Date.now().toString(36), includeDeleted: true })
        .then(function(result) {
          if (!result.initialized) {
            _syncV3CloudInitialized = false;
            localStorage.removeItem(CLOUD_INITIALIZED_KEY);
            if (isSharedDataEmpty(appState)) {
              var initializeEmpty = window.confirm('Cloud storage is empty. Initialize it for this household?');
              if (initializeEmpty) return bootstrapCloud();
              return;
            }
            var upload = window.confirm('Cloud storage is empty. Upload this device\'s inventory to initialize multi-device sync?\n\nChoose Cancel to keep working locally.');
            if (upload) return bootstrapCloud();
            showToast('Cloud not initialized. Changes remain saved locally.', 'info');
            return;
          }
          _syncV3CloudInitialized = true;
          localStorage.setItem(CLOUD_INITIALIZED_KEY, '1');
          return applyCanonicalAndProject(result.snapshot).then(function() {
            return window.flushOutbox();
          });
        }).then(function() {
          _syncLastFailed = false;
          hideOfflineBanner();
        }).catch(function(err) {
          if (err.code === 'PROTOCOL_VERSION_MISMATCH') {
            _syncV3ProtocolError = true;
            showOfflineBanner('Cloud sync update required: protocol version mismatch.');
          } else {
            _syncLastFailed = true;
            showOfflineBanner(err.message || 'Cannot reach cloud');
          }
          console.error('[SyncV3] Boot sync failed:', err);
        }).finally(function() {
          _syncInProgress = false;
          hideLoadingCloudOverlay();
          updatePillSyncStatus();
          updateSyncStatusBadge();
          updateLoginSyncStatus();
          syncUIComponents();
        });
    });
    return _syncV3Serial;
  };

  window.startupLoadFromCloud = function() { return window.bootSyncManager(); };
  window.syncDataEngine = function(interactive) {
    return window.bootSyncManager().then(function() {
      if (interactive) showToast('Synchronization complete.', 'success');
    });
  };

  var oldUpdatePill = window.updatePillSyncStatus;
  window.updatePillSyncStatus = function() {
    if (_syncV3ProtocolError) {
      ['syncStatusPill', 'syncStatusPillMobile'].forEach(function(id) {
        var pill = document.getElementById(id);
        if (pill) { pill.className = 'sync-pill pill-conflict'; pill.innerText = 'Update required'; }
      });
      return;
    }
    return oldUpdatePill.apply(this, arguments);
  };

  console.log('[SyncV3] Protocol v3 browser integration loaded.');
})();
