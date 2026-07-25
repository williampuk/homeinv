(function() {
  'use strict';

  if (!window.SyncV3Core) {
    console.error('[SyncV3] sync-v3-core.js was not loaded.');
    return;
  }

  var Core = window.SyncV3Core;
  var CANONICAL_KEY = 'fmi_sync_v3_canonical';
  var CLOUD_INITIALIZED_KEY = 'fmi_sync_v3_initialized';
  var _syncV3Queue = Promise.resolve();
  var _syncV3ProtocolError = false;
  var _syncV3CloudInitialized = localStorage.getItem(CLOUD_INITIALIZED_KEY) === '1';
  var _syncV3TaskDepth = 0;
  var _syncV3ConflictPanel = null;

  function clone(value) { return Core.clone(value); }

  function enqueueSyncTask(task) {
    _syncV3Queue = _syncV3Queue.catch(function() {}).then(function() {
      _syncV3TaskDepth += 1;
      return Promise.resolve().then(task).finally(function() {
        _syncV3TaskDepth -= 1;
      });
    });
    return _syncV3Queue;
  }

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

  function preserveLocalFields(snapshot) {
    var old = window.appState || appState || {};
    var projected = clone(snapshot || {});
    projected.meta = projected.meta || {};
    projected.meta.deviceId = old.meta && old.meta.deviceId || getDeviceId();
    projected.meta.lastSyncedAt = new Date().toISOString();
    projected.meta.lastServerRevision = Number(snapshot && snapshot.meta && snapshot.meta.serverSeq || 0);
    projected.meta.serverSeq = projected.meta.lastServerRevision;
    projected.meta.structureVersion = Number(snapshot && snapshot.meta && snapshot.meta.locationsVersion || 0);
    projected.meta.locationsVersion = projected.meta.structureVersion;
    projected.meta.categoryVersion = Number(snapshot && snapshot.meta && snapshot.meta.categoriesVersion || 0);
    projected.meta.categoriesVersion = projected.meta.categoryVersion;
    projected.meta.householdSettingsVersion = Number(snapshot && snapshot.meta && snapshot.meta.householdSettingsVersion || 0);
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

  function persistOperations(operations) {
    return operations.reduce(function(chain, op) {
      return chain.then(function() { return idbPutOutboxOp(op); });
    }, Promise.resolve());
  }

  function dependencyFor(ops, entityType, entityId) {
    return Core.latestDependency(ops, entityType, entityId);
  }

  function makeDocumentOperation(type, currentState, canonical, ops, deviceId) {
    var entityType;
    var version;
    var dep;
    if (type === Core.OP_TYPES.LOCATIONS_PUT) {
      entityType = 'locations';
      dep = dependencyFor(ops, entityType, entityType);
      version = Core.nextBaseVersion(canonical && canonical.meta && canonical.meta.locationsVersion || 0, dep);
      return Core.locationsPut(currentState, version, deviceId, dep && dep.opId);
    }
    if (type === Core.OP_TYPES.CATEGORIES_PUT) {
      entityType = 'categories';
      dep = dependencyFor(ops, entityType, entityType);
      version = Core.nextBaseVersion(canonical && canonical.meta && canonical.meta.categoriesVersion || 0, dep);
      return Core.categoriesPut(currentState, version, deviceId, dep && dep.opId);
    }
    entityType = 'householdSettings';
    dep = dependencyFor(ops, entityType, entityType);
    version = Core.nextBaseVersion(canonical && canonical.meta && canonical.meta.householdSettingsVersion || 0, dep);
    return Core.householdSettingsPut(currentState, version, deviceId, dep && dep.opId);
  }

  function buildItemDiffOperations(actionType, metadata, currentState, existingOps, projectedBefore, deviceId) {
    var itemId = metadata && metadata.itemId;
    var currentItem = Core.findItem(currentState, itemId);
    var previousItem = Core.findItem(projectedBefore, itemId);
    var generated = [];
    var workingOps = existingOps.slice();
    var itemDep = dependencyFor(workingOps, 'item', itemId);

    if (actionType === 'REMOVE_ITEM') {
      generated.push(Core.itemDelete(
        itemId,
        Core.nextBaseVersion(previousItem && previousItem.version || 0, itemDep),
        deviceId,
        itemDep && itemDep.opId
      ));
      return generated;
    }

    if (!currentItem) return generated;

    var itemOp = null;
    var itemBase = Core.nextBaseVersion(previousItem && previousItem.version || 0, itemDep);
    if (!previousItem || !compareItemMetadata(previousItem, currentItem)) {
      itemOp = Core.itemPut(currentItem, previousItem ? itemBase : 0, deviceId, itemDep && itemDep.opId);
      generated.push(itemOp);
      workingOps.push(itemOp);
    }

    if (currentItem.itemType !== 'stock') return generated;

    var oldEntries = {};
    var newEntries = {};
    ((previousItem && previousItem.stockEntries) || []).forEach(function(entry) { oldEntries[entry.id] = entry; });
    (currentItem.stockEntries || []).forEach(function(entry) { newEntries[entry.id] = entry; });

    Object.keys(oldEntries).forEach(function(entryId) {
      if (!newEntries[entryId] || newEntries[entryId].hiddenAt) {
        var oldEntry = oldEntries[entryId];
        var entryDep = dependencyFor(workingOps, 'stockEntry', entryId);
        var deleteOp = Core.stockEntryDelete(
          itemId,
          entryId,
          Core.nextBaseVersion(oldEntry.version || 0, entryDep),
          deviceId,
          entryDep && entryDep.opId
        );
        generated.push(deleteOp);
        workingOps.push(deleteOp);
      }
    });

    Object.keys(newEntries).forEach(function(entryId) {
      var nextEntry = newEntries[entryId];
      if (nextEntry.hiddenAt) return;
      var oldEntry = oldEntries[entryId];
      var entryDep = dependencyFor(workingOps, 'stockEntry', entryId);
      if (!oldEntry) {
        // A stock entry created with a new item must wait for the parent item.
        var parentDependency = itemOp && itemOp.opId || itemDep && itemDep.opId || null;
        var createOp = Core.stockEntryPut(itemId, nextEntry, 0, Number(nextEntry.quantity || 0), deviceId, parentDependency);
        generated.push(createOp);
        workingOps.push(createOp);
        return;
      }
      if (!compareEntryMetadata(oldEntry, nextEntry)) {
        var putOp = Core.stockEntryPut(
          itemId,
          nextEntry,
          Core.nextBaseVersion(oldEntry.version || 0, entryDep),
          0,
          deviceId,
          entryDep && entryDep.opId
        );
        generated.push(putOp);
        workingOps.push(putOp);
        entryDep = putOp;
      }
      var delta = Number(nextEntry.quantity || 0) - Number(oldEntry.quantity || 0);
      if (delta !== 0) {
        var adjustOp = Core.stockAdjust(itemId, entryId, delta, deviceId, entryDep && entryDep.opId);
        generated.push(adjustOp);
        workingOps.push(adjustOp);
      }
    });

    return generated;
  }

  function queueMutation(actionType, metadata, currentState) {
    return idbGetOutboxOps().then(function(ops) {
      ops = ops || [];
      var canonical = getCanonicalSnapshot() || sharedSnapshotFromState(currentState);
      var projectedBefore = Core.projectState(canonical, ops);
      var deviceId = currentState.meta && currentState.meta.deviceId || getDeviceId();
      var locationActions = ['ADD_SEGMENT', 'RENAME_SEGMENT', 'DELETE_SEGMENT', 'ADD_CONTAINER', 'RENAME_CONTAINER', 'DELETE_CONTAINER', 'ADD_SUBCONTAINER', 'ADD_SUB_CONTAINER', 'RENAME_SUBCONTAINER', 'RENAME_SUB_CONTAINER', 'DELETE_SUBCONTAINER', 'DELETE_SUB_CONTAINER', 'SAVE_LAYOUT', 'UPDATE_COORDINATE', 'UPDATE_BACKGROUND_IMAGE'];
      var categoryActions = ['ADD_CATEGORY', 'DELETE_CATEGORY', 'SAVE_CLASSIFICATION'];
      var settingActions = ['ADD_USER', 'REMOVE_USER', 'SET_REMINDER'];
      var generated = [];

      if (locationActions.indexOf(actionType) >= 0) {
        generated = [makeDocumentOperation(Core.OP_TYPES.LOCATIONS_PUT, currentState, canonical, ops, deviceId)];
      } else if (categoryActions.indexOf(actionType) >= 0) {
        generated = [makeDocumentOperation(Core.OP_TYPES.CATEGORIES_PUT, currentState, canonical, ops, deviceId)];
      } else if (settingActions.indexOf(actionType) >= 0) {
        generated = [makeDocumentOperation(Core.OP_TYPES.HOUSEHOLD_SETTINGS_PUT, currentState, canonical, ops, deviceId)];
      } else if (['COMMIT_ITEM', 'EDIT_ITEM', 'REMOVE_ITEM', 'STOCK_IN', 'STOCK_OUT'].indexOf(actionType) >= 0) {
        generated = buildItemDiffOperations(actionType, metadata || {}, currentState, ops, projectedBefore, deviceId);
      }

      return persistOperations(Core.sortOperations(generated)).then(function() {
        return generated;
      });
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
      updatePillSyncStatus();
      updateSyncStatusBadge();
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
      ops = ops || [];
      var projectedShared = Core.projectState(snapshot, ops);
      var nextState = preserveLocalFields(projectedShared);
      nextState.syncConflicts = ops.filter(function(op) {
        return ['conflict', 'rejected', 'blocked'].indexOf(op.status) >= 0;
      }).map(function(op) { return op.lastResult || op; });
      appState = nextState;
      window.appState = appState;
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

  window.getCloudState = function() {
    return postV3('SYNC_PULL', {
      deviceId: getDeviceId(),
      requestId: 'req_' + Date.now().toString(36),
      includeDeleted: true
    }).then(function(result) {
      if (!result.initialized) return null;
      return result.snapshot;
    });
  };

  function clearBootstrapRepresentedOutbox() {
    return idbGetOutboxOps().then(function(ops) {
      return Promise.all((ops || []).map(function(op) { return idbDeleteOutboxOp(op.opId); }));
    });
  }

  function bootstrapCloudRaw() {
    return idbGetOutboxOps().then(function(ops) {
      var snapshot = sharedSnapshotFromState(appState);
      // appState already contains the local projection, so the snapshot includes
      // all pending operations exactly once.
      return postV3('SYNC_BOOTSTRAP', {
        deviceId: getDeviceId(),
        requestId: 'req_' + Date.now().toString(36),
        expectedServerSeq: 0,
        snapshot: snapshot
      }).then(function(result) {
        return clearBootstrapRepresentedOutbox().then(function() {
          return applyCanonicalAndProject(result.snapshot);
        });
      });
    });
  }

  function processPushResults(submitted, result) {
    var byId = {};
    submitted.forEach(function(op) { byId[op.opId] = op; });
    var returned = {};
    (result.results || []).forEach(function(opResult) { if (opResult && opResult.opId) returned[opResult.opId] = opResult; });

    return submitted.reduce(function(chain, op) {
      return chain.then(function() {
        var opResult = returned[op.opId];
        var action = Core.operationResultAction(opResult);
        if (action === 'delete') return idbDeleteOutboxOp(op.opId);
        if (action === 'retry') return setOutboxStatus(op, 'retry', opResult || { errorCode: 'MISSING_OPERATION_RESULT' });
        return setOutboxStatus(op, action, opResult);
      });
    }, Promise.resolve()).then(function() {
      _syncConflict = Object.keys(returned).some(function(opId) {
        return ['conflict', 'rejected', 'blocked'].indexOf(returned[opId].status) >= 0;
      });
      return applyCanonicalAndProject(result.snapshot);
    });
  }

  function flushOutboxRaw() {
    var endpoint = localStorage.getItem('sys_gas_url');
    var secret = localStorage.getItem('sys_api_pwd');
    if (!endpoint || !secret || !_syncV3CloudInitialized || _syncV3ProtocolError) return Promise.resolve();
    if (_outboxFlushInProgress) return Promise.resolve();
    _outboxFlushInProgress = true;
    _syncLastFailed = false;
    updatePillSyncStatus();
    updateSyncStatusBadge();

    var submitted = [];
    return idbGetOutboxOps().then(function(ops) {
      submitted = Core.sortOperations((ops || []).filter(function(op) {
        return ['pending', 'retry'].indexOf(op.status || 'pending') >= 0;
      }));
      if (!submitted.length) return null;
      submitted.forEach(function(op) { op.attemptedAt = new Date().toISOString(); });
      return persistOperations(submitted).then(function() {
        return postV3('SYNC_PUSH', {
          deviceId: getDeviceId(),
          requestId: 'req_' + Date.now().toString(36),
          operations: submitted.map(function(op) {
            var copy = clone(op);
            delete copy.status;
            delete copy.lastResult;
            delete copy.updatedAt;
            delete copy.attemptedAt;
            return copy;
          })
        });
      });
    }).then(function(result) {
      if (!result) return;
      return processPushResults(submitted, result);
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
  }

  window.flushOutbox = function() {
    if (_syncV3TaskDepth > 0) return flushOutboxRaw();
    return enqueueSyncTask(flushOutboxRaw);
  };

  function pullCloudRaw() {
    var endpoint = localStorage.getItem('sys_gas_url');
    if (!endpoint || _syncInProgress) return Promise.resolve();
    _syncInProgress = true;
    _syncLastFailed = false;
    _syncConflict = false;
    showLoadingCloudOverlay();
    updatePillSyncStatus();

    return postV3('SYNC_PULL', {
      deviceId: getDeviceId(),
      requestId: 'req_' + Date.now().toString(36),
      includeDeleted: true
    }).then(function(result) {
      if (!result.initialized) {
        _syncV3CloudInitialized = false;
        localStorage.removeItem(CLOUD_INITIALIZED_KEY);
        if (isSharedDataEmpty(appState)) {
          if (window.confirm('Cloud storage is empty. Initialize it for this household?')) return bootstrapCloudRaw();
          return;
        }
        if (window.confirm('Cloud storage is empty. Upload this device\'s inventory to initialize multi-device sync?\n\nChoose Cancel to keep working locally.')) {
          return bootstrapCloudRaw();
        }
        showToast('Cloud not initialized. Changes remain saved locally.', 'info');
        return;
      }
      _syncV3CloudInitialized = true;
      localStorage.setItem(CLOUD_INITIALIZED_KEY, '1');
      return applyCanonicalAndProject(result.snapshot).then(flushOutboxRaw);
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
      throw err;
    }).finally(function() {
      _syncInProgress = false;
      hideLoadingCloudOverlay();
      updatePillSyncStatus();
      updateSyncStatusBadge();
      updateLoginSyncStatus();
      syncUIComponents();
    });
  }

  window.bootSyncManager = function() {
    return enqueueSyncTask(pullCloudRaw).catch(function() {});
  };

  window.startupLoadFromCloud = function() { return window.bootSyncManager(); };
  window.syncDataEngine = function(interactive) {
    return window.bootSyncManager().then(function() {
      if (interactive) showToast('Synchronization complete.', 'success');
    });
  };
  window.syncNow = function(opts) {
    opts = opts || {};
    if (opts.interactive !== false) showToast('Syncing...', 'info');
    return window.bootSyncManager();
  };
  window.triggerSynchronousCloudFetchPull = function() {
    return window.bootSyncManager();
  };
  window.triggerAutoCloudSyncIfPossible = function() {
    setTimeout(function() { window.bootSyncManager(); }, 300);
  };
  window.autoPullFromCloudIfPossible = function() {
    return window.bootSyncManager();
  };
  window.verifyCloudSync = function() {
    return postV3('SYNC_PULL', { deviceId: getDeviceId(), requestId: 'verify_' + Date.now().toString(36), includeDeleted: true })
      .then(function(result) {
        if (!result.initialized) throw new Error('Cloud is not initialized.');
        var localActive = (appState.inventory || []).filter(function(item) { return !item.deletedAt; }).length;
        var remoteActive = (result.snapshot.inventory || []).filter(function(item) { return !item.deletedAt; }).length;
        var pendingPromise = idbGetOutboxOps();
        return pendingPromise.then(function(ops) {
          if ((ops || []).length === 0 && localActive === remoteActive) {
            showToast('✅ In sync — ' + localActive + ' items, revision ' + result.serverSeq, 'success');
          } else {
            showToast('⚠️ Sync review needed — ' + (ops || []).length + ' local operation(s) remain.', 'error');
          }
        });
      }).catch(function(err) {
        _syncLastFailed = true;
        updateSyncStatusBadge();
        showToast('Sync verification failed: ' + err.message, 'error');
      });
  };

  function removeConflictPanel() {
    if (_syncV3ConflictPanel && _syncV3ConflictPanel.parentNode) _syncV3ConflictPanel.parentNode.removeChild(_syncV3ConflictPanel);
    _syncV3ConflictPanel = null;
  }

  function discardOperation(opId) {
    return idbDeleteOutboxOp(opId).then(function() {
      removeConflictPanel();
      return applyCanonicalAndProject(getCanonicalSnapshot() || sharedSnapshotFromState(appState));
    });
  }

  function retryConflictKeepingLocal(op) {
    var result = op.lastResult || {};
    var actualVersion = Number(result.actualVersion || 0);
    var replacement = null;
    if (op.type === Core.OP_TYPES.ITEM_PUT && result.errorCode !== 'ENTITY_DELETED') {
      replacement = Core.makeOperation({
        type: op.type,
        entityType: op.entityType,
        entityId: op.entityId,
        baseVersion: actualVersion,
        deviceId: getDeviceId(),
        payload: clone(op.payload)
      });
    } else if (op.type === Core.OP_TYPES.ITEM_DELETE && result.errorCode !== 'ENTITY_DELETED') {
      replacement = Core.itemDelete(op.entityId, actualVersion, getDeviceId());
    } else if (op.type === Core.OP_TYPES.STOCK_ENTRY_PUT && result.errorCode !== 'ENTITY_DELETED') {
      replacement = Core.makeOperation({
        type: op.type,
        entityType: op.entityType,
        entityId: op.entityId,
        baseVersion: actualVersion,
        deviceId: getDeviceId(),
        payload: clone(op.payload)
      });
    } else if (op.type === Core.OP_TYPES.STOCK_ENTRY_DELETE && result.errorCode !== 'ENTITY_DELETED') {
      replacement = Core.makeOperation({
        type: op.type,
        entityType: op.entityType,
        entityId: op.entityId,
        baseVersion: actualVersion,
        deviceId: getDeviceId(),
        payload: clone(op.payload)
      });
    } else if (op.type === Core.OP_TYPES.LOCATIONS_PUT) {
      replacement = Core.locationsPut({
        segments: op.payload.segments,
        coordinates: op.payload.coordinates,
        spatialBackgroundImage: op.payload.spatialBackgroundImage
      }, actualVersion, getDeviceId());
    } else if (op.type === Core.OP_TYPES.CATEGORIES_PUT) {
      replacement = Core.categoriesPut({ categories: op.payload.categories }, actualVersion, getDeviceId());
    } else if (op.type === Core.OP_TYPES.HOUSEHOLD_SETTINGS_PUT) {
      replacement = Core.householdSettingsPut({
        users: op.payload.users,
        userEmails: op.payload.userEmails,
        reminderDays: op.payload.reminderDays
      }, actualVersion, getDeviceId());
    }
    if (!replacement) {
      showToast('This conflict cannot be automatically reapplied. Review the details and create a new item/change manually.', 'error');
      return Promise.resolve();
    }
    return idbDeleteOutboxOp(op.opId).then(function() {
      return idbPutOutboxOp(replacement);
    }).then(function() {
      removeConflictPanel();
      return flushOutboxRaw();
    });
  }

  function showConflictDetails(op) {
    var result = op.lastResult || {};
    var detail = {
      operation: { type: op.type, entityId: op.entityId, baseVersion: op.baseVersion, payload: op.payload },
      serverResult: result
    };
    window.alert(JSON.stringify(detail, null, 2));
  }

  function openConflictPanel() {
    idbGetOutboxOps().then(function(ops) {
      var problems = (ops || []).filter(function(op) {
        return ['conflict', 'rejected', 'blocked'].indexOf(op.status) >= 0;
      });
      if (!problems.length) return;
      removeConflictPanel();
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.65);display:flex;align-items:center;justify-content:center;padding:16px';
      var panel = document.createElement('div');
      panel.style.cssText = 'background:white;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:760px;width:100%;max-height:85vh;overflow:auto;padding:20px';
      panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><h2 style="font-size:18px;font-weight:700">Synchronization problems</h2><button data-close style="font-size:22px">×</button></div>';
      problems.forEach(function(op) {
        var result = op.lastResult || {};
        var row = document.createElement('div');
        row.style.cssText = 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:10px';
        var keepAllowed = op.status === 'conflict' && result.errorCode !== 'ENTITY_DELETED';
        row.innerHTML = '<div style="font-weight:700;font-size:13px">' + String(op.type) + ' — ' + String(op.entityId) + '</div>' +
          '<div style="font-size:12px;color:#64748b;margin:4px 0 10px">' + String(result.errorCode || op.status) + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap"><button data-discard style="padding:6px 10px;border-radius:7px;background:#e2e8f0">Use cloud / discard local</button>' +
          (keepAllowed ? '<button data-keep style="padding:6px 10px;border-radius:7px;background:#2563eb;color:white">Keep my version</button>' : '') +
          '<button data-detail style="padding:6px 10px;border-radius:7px;background:#f8fafc;border:1px solid #cbd5e1">Review details</button></div>';
        row.querySelector('[data-discard]').onclick = function() { discardOperation(op.opId); };
        if (keepAllowed) row.querySelector('[data-keep]').onclick = function() { retryConflictKeepingLocal(op); };
        row.querySelector('[data-detail]').onclick = function() { showConflictDetails(op); };
        panel.appendChild(row);
      });
      overlay.appendChild(panel);
      overlay.onclick = function(event) { if (event.target === overlay) removeConflictPanel(); };
      panel.querySelector('[data-close]').onclick = removeConflictPanel;
      document.body.appendChild(overlay);
      _syncV3ConflictPanel = overlay;
    });
  }

  var oldUpdatePill = window.updatePillSyncStatus;
  window.updatePillSyncStatus = function() {
    if (_syncV3ProtocolError) {
      ['syncStatusPill', 'syncStatusPillMobile'].forEach(function(id) {
        var pill = document.getElementById(id);
        if (pill) {
          pill.className = 'sync-pill pill-conflict';
          pill.innerText = 'Update required';
        }
      });
      return;
    }
    var result = oldUpdatePill.apply(this, arguments);
    setTimeout(function() {
      idbGetOutboxOps().then(function(ops) {
        var hasProblems = (ops || []).some(function(op) {
          return ['conflict', 'rejected', 'blocked'].indexOf(op.status) >= 0;
        });
        if (!hasProblems) return;
        ['syncStatusPill', 'syncStatusPillMobile'].forEach(function(id) {
          var pill = document.getElementById(id);
          if (!pill) return;
          pill.className = 'sync-pill pill-conflict';
          pill.innerText = '⚠ Needs review';
          pill.onclick = openConflictPanel;
        });
      });
    }, 0);
    return result;
  };

  console.log('[SyncV3] Protocol v3 browser integration loaded.');
})();
