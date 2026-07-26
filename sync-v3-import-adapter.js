(function() {
  'use strict';

  if (typeof window.importExcelToLocalDatabases !== 'function' || typeof window.mutateState !== 'function') return;
  if (window.importExcelToLocalDatabases.__syncV3ImportWrapped) return;

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).sort().forEach(function(key) {
        if (['version', 'updatedAt', 'lastModifiedBy', 'timestamp'].indexOf(key) >= 0) return;
        out[key] = stable(value[key]);
      });
      return out;
    }
    return value;
  }
  function equal(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }

  function enqueueImportDiff(beforeState, afterState) {
    var actions = [];
    var beforeItems = {};
    var afterItems = {};
    (beforeState.inventory || []).forEach(function(item) { if (item && item.id) beforeItems[item.id] = item; });
    (afterState.inventory || []).forEach(function(item) { if (item && item.id) afterItems[item.id] = item; });
    var ids = {};
    Object.keys(beforeItems).forEach(function(id) { ids[id] = true; });
    Object.keys(afterItems).forEach(function(id) { ids[id] = true; });

    Object.keys(ids).sort().forEach(function(id) {
      var before = beforeItems[id];
      var after = afterItems[id];
      if (before && !before.deletedAt && (!after || after.deletedAt)) actions.push(['REMOVE_ITEM', { itemId: id }]);
      else if (after && !before) actions.push(['COMMIT_ITEM', { itemId: id }]);
      else if (after && !equal(before, after)) actions.push(['EDIT_ITEM', { itemId: id }]);
    });

    if (!equal(
      { segments: beforeState.segments || {}, coordinates: beforeState.coordinates || {}, spatialBackgroundImage: beforeState.spatialBackgroundImage || null },
      { segments: afterState.segments || {}, coordinates: afterState.coordinates || {}, spatialBackgroundImage: afterState.spatialBackgroundImage || null }
    )) actions.push(['SAVE_LAYOUT', {}]);
    if (!equal(beforeState.categories || {}, afterState.categories || {})) actions.push(['SAVE_CLASSIFICATION', {}]);
    if (!equal(
      { users: beforeState.users || ['Default'], userEmails: beforeState.userEmails || {}, reminderDays: beforeState.reminderDays || 30 },
      { users: afterState.users || ['Default'], userEmails: afterState.userEmails || {}, reminderDays: afterState.reminderDays || 30 }
    )) actions.push(['SET_REMINDER', {}]);

    return actions.reduce(function(chain, action) {
      return chain.then(function() { return window.mutateState(action[0], action[1]); });
    }, Promise.resolve()).then(function() {
      if (actions.length) console.log('[SyncV3] Excel import queued ' + actions.length + ' synchronization mutation(s).');
      return actions.length;
    });
  }

  window.syncV3QueueImportedState = enqueueImportDiff;

  var originalImport = window.importExcelToLocalDatabases;
  function wrappedImport(event) {
    var beforeState = clone(window.appState || appState || {});
    var NativeFileReader = window.FileReader;
    function ImportFileReader() {
      var reader = new NativeFileReader();
      var nativeRead = reader.readAsArrayBuffer;
      reader.readAsArrayBuffer = function(file) {
        var originalOnload = reader.onload;
        reader.onload = function(loadEvent) {
          var returned;
          var importCommitted = false;
          var originalSave = window.saveStateToLocalStorage;

          // The legacy importer mutates appState while parsing and calls
          // saveStateToLocalStorage only after the workbook has been accepted.
          // Observe that commit point so a thrown parse/validation error cannot
          // enqueue and upload a partially mutated in-memory workbook.
          if (typeof originalSave === 'function') {
            window.saveStateToLocalStorage = function() {
              importCommitted = true;
              return originalSave.apply(this, arguments);
            };
          }

          try {
            if (originalOnload) returned = originalOnload.call(reader, loadEvent);
          } finally {
            if (typeof originalSave === 'function') window.saveStateToLocalStorage = originalSave;
            if (importCommitted) {
              enqueueImportDiff(beforeState, clone(window.appState || appState || {})).catch(function(error) {
                console.error('[SyncV3] Excel import sync queueing failed:', error);
                if (typeof showToast === 'function') showToast('Import saved locally, but synchronization queueing failed: ' + error.message, 'error');
              });
            } else {
              console.warn('[SyncV3] Excel import did not reach its persistence point; no synchronization operations were queued.');
            }
          }
          return returned;
        };
        return nativeRead.call(reader, file);
      };
      return reader;
    }
    ImportFileReader.prototype = NativeFileReader.prototype;
    window.FileReader = ImportFileReader;
    try { return originalImport.call(this, event); }
    finally { window.FileReader = NativeFileReader; }
  }
  wrappedImport.__syncV3ImportWrapped = true;
  window.importExcelToLocalDatabases = wrappedImport;
})();
