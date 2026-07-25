var CONFIG = {
  protocolVersion: 3,
  schemaVersion: '3.0.0',
  maxCellSize: 40000,
  maxOperations: 100,
  maxRequestChars: 500000,
  secretProperty: 'SYNC_SECRET_TOKEN'
};

function doGet(e) { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail(code, message, retryable, extra) {
  var out = { success: false, errorCode: code, message: message || code, retryable: !!retryable };
  Object.keys(extra || {}).forEach(function(k) { out[k] = extra[k]; });
  return out;
}

function getSecretToken() {
  return PropertiesService.getScriptProperties().getProperty(CONFIG.secretProperty) || '';
}

function validatePassword(token) {
  var expected = getSecretToken();
  if (!expected) return fail('AUTH_FAILED', 'Server sync secret is not configured.', false);
  if (!token || token !== expected) return fail('AUTH_FAILED', 'Invalid authentication token.', false);
  return null;
}

function ensureSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (headers && sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
  return sheet;
}

function parseRequest(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = {};
  if (e.postData && e.postData.contents) {
    if (e.postData.contents.length > CONFIG.maxRequestChars) throw new Error('PAYLOAD_TOO_LARGE');
    try { body = JSON.parse(e.postData.contents); } catch (ignore) {}
  }
  var payloadRaw = body.payload !== undefined ? body.payload : p.payload;
  var payload = {};
  if (payloadRaw && typeof payloadRaw === 'object') payload = payloadRaw;
  else if (payloadRaw) {
    try { payload = JSON.parse(payloadRaw); } catch (ex) { throw new Error('INVALID_REQUEST'); }
  }
  return {
    token: String(body.token || p.token || ''),
    action: String(body.action || p.action || ''),
    protocolVersion: Number(body.protocolVersion || p.protocolVersion || 0),
    payload: payload,
    data: String(body.data || p.data || ''),
    fileName: String(body.fileName || p.fileName || '')
  };
}

function handleRequest(e) {
  try {
    var req = parseRequest(e);
    var authError = validatePassword(req.token);
    if (authError) return jsonResponse(authError);

    if (req.action === 'IMAGE_UPLOAD') return jsonResponse(handleImageUpload(req));
    if (req.action === 'SEND_REMINDERS') return jsonResponse(handleSendReminders(req));

    if (req.protocolVersion !== CONFIG.protocolVersion) {
      return jsonResponse(fail('PROTOCOL_VERSION_MISMATCH', 'Client and server sync protocols differ.', false, {
        expectedProtocolVersion: CONFIG.protocolVersion,
        receivedProtocolVersion: req.protocolVersion
      }));
    }

    if (req.action === 'SYNC_PULL') return jsonResponse(handleSyncPull(req.payload));
    if (req.action === 'SYNC_PUSH') return jsonResponse(handleSyncPush(req.payload));
    if (req.action === 'SYNC_BOOTSTRAP') return jsonResponse(handleSyncBootstrap(req.payload));

    return jsonResponse(fail('INVALID_REQUEST', 'Unknown action: ' + req.action, false));
  } catch (err) {
    var code = String(err && err.message || err || 'INTERNAL_ERROR');
    var known = ['PAYLOAD_TOO_LARGE', 'INVALID_REQUEST', 'SNAPSHOT_CORRUPT', 'CHECKSUM_MISMATCH'];
    return jsonResponse(fail(known.indexOf(code) >= 0 ? code : 'INTERNAL_ERROR', code, false));
  }
}

function ensureMetaSheet() {
  return ensureSheet('Meta', ['key', 'value']);
}

function readMeta() {
  var sheet = ensureMetaSheet();
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues() : [];
  var meta = {};
  rows.forEach(function(r) { if (r[0]) meta[String(r[0])] = String(r[1]); });
  return {
    protocolVersion: Number(meta.protocolVersion || CONFIG.protocolVersion),
    schemaVersion: meta.schemaVersion || CONFIG.schemaVersion,
    initialized: meta.initialized === 'true',
    activeSlot: meta.activeSlot || 'A',
    serverSeq: Number(meta.serverSeq || 0),
    updatedAt: meta.updatedAt || '',
    activeChecksum: meta.activeChecksum || '',
    activeChunkCount: Number(meta.activeChunkCount || 0)
  };
}

function writeMeta(meta) {
  var sheet = ensureMetaSheet();
  var rows = [
    ['protocolVersion', String(CONFIG.protocolVersion)],
    ['schemaVersion', CONFIG.schemaVersion],
    ['initialized', meta.initialized ? 'true' : 'false'],
    ['activeSlot', meta.activeSlot || 'A'],
    ['serverSeq', String(meta.serverSeq || 0)],
    ['updatedAt', meta.updatedAt || ''],
    ['activeChecksum', meta.activeChecksum || ''],
    ['activeChunkCount', String(meta.activeChunkCount || 0)]
  ];
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).clearContent();
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

function checksum(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return digest.map(function(b) { var n = b < 0 ? b + 256 : b; return ('0' + n.toString(16)).slice(-2); }).join('');
}

function normalizeSnapshot(input, serverSeq) {
  var state = input && typeof input === 'object' ? JSON.parse(JSON.stringify(input)) : {};
  state.protocolVersion = CONFIG.protocolVersion;
  state.schemaVersion = CONFIG.schemaVersion;
  state.meta = state.meta || {};
  state.meta.initialized = true;
  state.meta.serverSeq = Number(serverSeq || state.meta.serverSeq || 0);
  state.meta.locationsVersion = Number(state.meta.locationsVersion || state.meta.structureVersion || 0);
  state.meta.categoriesVersion = Number(state.meta.categoriesVersion || state.meta.categoryVersion || 0);
  state.meta.householdSettingsVersion = Number(state.meta.householdSettingsVersion || 0);
  state.segments = state.segments || {};
  state.coordinates = state.coordinates || {};
  state.spatialBackgroundImage = state.spatialBackgroundImage || null;
  state.categories = state.categories || {};
  state.inventory = Array.isArray(state.inventory) ? state.inventory : [];
  state.users = Array.isArray(state.users) && state.users.length ? state.users : ['Default'];
  if (state.users.indexOf('Default') < 0) state.users.unshift('Default');
  state.userEmails = state.userEmails || {};
  state.reminderDays = Math.max(1, Math.min(365, Number(state.reminderDays || 30)));
  delete state.syncQueue;
  delete state.syncConflicts;
  delete state.currentUser;
  delete state.language;
  delete state.reminderLog;

  var now = new Date().toISOString();
  state.inventory.forEach(function(item) {
    item.version = Math.max(1, Number(item.version || 1));
    item.createdAt = item.createdAt || item.timestamp || now;
    item.updatedAt = item.updatedAt || item.createdAt;
    item.deletedAt = item.deletedAt || null;
    item.stockEntries = Array.isArray(item.stockEntries) ? item.stockEntries : [];
    item.stockEntries.forEach(function(entry) {
      entry.version = Math.max(1, Number(entry.version || 1));
      entry.quantity = Math.max(0, Number(entry.quantity || 0));
      entry.createdAt = entry.createdAt || entry.updatedAt || item.createdAt;
      entry.updatedAt = entry.updatedAt || entry.createdAt;
      entry.hiddenAt = entry.hiddenAt || null;
    });
    item.quantity = recomputeItemQuantity(item);
  });
  return state;
}

function readSlot(slot, chunkCount, expectedChecksum) {
  if (!chunkCount) return null;
  var sheet = ensureSheet('Data_' + slot);
  var values = sheet.getRange(1, 1, chunkCount, 1).getValues();
  var text = values.map(function(r) { return String(r[0] || ''); }).join('');
  if (expectedChecksum && checksum(text) !== expectedChecksum) throw new Error('CHECKSUM_MISMATCH');
  try { return JSON.parse(text); } catch (ex) { throw new Error('SNAPSHOT_CORRUPT'); }
}

function loadCanonical(meta) {
  if (!meta.initialized) return null;
  return normalizeSnapshot(readSlot(meta.activeSlot, meta.activeChunkCount, meta.activeChecksum), meta.serverSeq);
}

function writeCanonicalAtomically(state, meta) {
  var inactive = meta.activeSlot === 'A' ? 'B' : 'A';
  state = normalizeSnapshot(state, meta.serverSeq);
  state.meta.updatedAt = new Date().toISOString();
  var text = JSON.stringify(state);
  var count = Math.max(1, Math.ceil(text.length / CONFIG.maxCellSize));
  var sheet = ensureSheet('Data_' + inactive);
  sheet.clearContents();
  var rows = [];
  for (var i = 0; i < count; i++) rows.push([text.substring(i * CONFIG.maxCellSize, (i + 1) * CONFIG.maxCellSize)]);
  sheet.getRange(1, 1, rows.length, 1).setValues(rows);
  SpreadsheetApp.flush();
  var verify = sheet.getRange(1, 1, count, 1).getValues().map(function(r) { return String(r[0] || ''); }).join('');
  var sum = checksum(text);
  if (verify !== text || checksum(verify) !== sum) throw new Error('CHECKSUM_MISMATCH');
  meta.activeSlot = inactive;
  meta.activeChecksum = sum;
  meta.activeChunkCount = count;
  meta.updatedAt = state.meta.updatedAt;
  meta.initialized = true;
  writeMeta(meta);
  SpreadsheetApp.flush();
  return state;
}

function handleSyncPull(payload) {
  var meta = readMeta();
  if (!meta.initialized) return { success: true, initialized: false, serverSeq: 0, snapshot: null };
  return { success: true, initialized: true, serverSeq: meta.serverSeq, snapshot: loadCanonical(meta) };
}

function withSyncLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail('SERVER_BUSY', 'Synchronization is temporarily busy.', true);
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function handleSyncBootstrap(payload) {
  return withSyncLock(function() {
    var meta = readMeta();
    if (meta.initialized || Number(payload.expectedServerSeq || 0) !== 0) {
      return fail('SERVER_ALREADY_INITIALIZED', 'Cloud data has already been initialized.', false);
    }
    var state = normalizeSnapshot(payload.snapshot || {}, 0);
    meta.serverSeq = 0;
    state = writeCanonicalAtomically(state, meta);
    writeAudit(payload.deviceId || '', 'SYNC_BOOTSTRAP', 0, true, '');
    return { success: true, initialized: true, serverSeq: 0, snapshot: state };
  });
}

function ensureOpsSheet() {
  return ensureSheet('Ops', ['serverSeq', 'opId', 'operationHash', 'deviceId', 'type', 'entityType', 'entityId', 'status', 'errorCode', 'entityVersion', 'timestamp', 'json']);
}

function loadOperationIndex() {
  var sheet = ensureOpsSheet();
  var out = {};
  if (sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 12).getValues().forEach(function(r) {
    var extra = {};
    try { extra = JSON.parse(r[11] || '{}'); } catch (ignore) {}
    out[String(r[1])] = {
      serverSeq: Number(r[0] || 0), opId: String(r[1] || ''), operationHash: String(r[2] || ''),
      deviceId: String(r[3] || ''), type: String(r[4] || ''), entityType: String(r[5] || ''),
      entityId: String(r[6] || ''), status: String(r[7] || ''), errorCode: String(r[8] || ''),
      entityVersion: Number(r[9] || 0), timestamp: String(r[10] || ''),
      expectedVersion: extra.expectedVersion, actualVersion: extra.actualVersion, serverEntity: extra.serverEntity
    };
  });
  return out;
}

function opHash(op) {
  var stable = {
    opId: op.opId, type: op.type, entityType: op.entityType, entityId: op.entityId,
    baseVersion: Number(op.baseVersion || 0), dependsOnOpId: op.dependsOnOpId || null,
    deviceId: op.deviceId || '', payload: op.payload || {}
  };
  return checksum(JSON.stringify(stable));
}

function appendOperation(op, hash, result) {
  var sheet = ensureOpsSheet();
  sheet.appendRow([
    result.serverSeq || '', op.opId || '', hash, op.deviceId || '', op.type || '', op.entityType || '',
    op.entityId || '', result.status || '', result.errorCode || '', result.entityVersion || '',
    new Date().toISOString(), JSON.stringify({
      expectedVersion: result.expectedVersion, actualVersion: result.actualVersion, serverEntity: result.serverEntity || null
    })
  ]);
}

function resultFor(op, status, extra) {
  var out = { opId: op.opId || '', status: status, entityType: op.entityType || '', entityId: op.entityId || '' };
  Object.keys(extra || {}).forEach(function(k) { out[k] = extra[k]; });
  return out;
}

function validateOperation(op) {
  if (!op || !op.opId || !op.type || !op.entityType || !op.entityId) return 'INVALID_OPERATION';
  var allowed = ['ITEM_PUT', 'ITEM_DELETE', 'STOCK_ENTRY_PUT', 'STOCK_ENTRY_DELETE', 'STOCK_ADJUST', 'LOCATIONS_PUT', 'CATEGORIES_PUT', 'HOUSEHOLD_SETTINGS_PUT'];
  if (allowed.indexOf(op.type) < 0) return 'UNKNOWN_OPERATION';
  return '';
}

function findItem(state, id) {
  return (state.inventory || []).find(function(item) { return item.id === id; }) || null;
}

function findEntry(item, id) {
  return ((item && item.stockEntries) || []).find(function(entry) { return entry.id === id; }) || null;
}

function recomputeItemQuantity(item) {
  return ((item && item.stockEntries) || []).reduce(function(sum, entry) {
    return entry && !entry.hiddenAt ? sum + Number(entry.quantity || 0) : sum;
  }, 0);
}

function conflict(op, actualVersion, serverEntity, code) {
  return resultFor(op, 'conflict', {
    errorCode: code || 'VERSION_CONFLICT', expectedVersion: Number(op.baseVersion || 0),
    actualVersion: Number(actualVersion || 0), serverEntity: JSON.parse(JSON.stringify(serverEntity || null))
  });
}

function applyOperation(state, meta, op) {
  var p = op.payload || {};
  var now = new Date().toISOString();
  var item, entry, incoming, version;

  if (op.type === 'ITEM_PUT') {
    item = findItem(state, op.entityId);
    if (!item) {
      if (Number(op.baseVersion || 0) !== 0) return conflict(op, 0, null, 'ENTITY_NOT_FOUND');
      incoming = p.item || {};
      if (!incoming.id || incoming.id !== op.entityId) return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
      incoming = JSON.parse(JSON.stringify(incoming));
      delete incoming.stockEntries; delete incoming.quantity; delete incoming.deletedAt;
      incoming.version = 1; incoming.createdAt = now; incoming.updatedAt = now; incoming.deletedAt = null; incoming.stockEntries = [];
      state.inventory.push(incoming);
      return resultFor(op, 'applied', { entityVersion: 1 });
    }
    if (item.deletedAt) return conflict(op, item.version, item, 'ENTITY_DELETED');
    if (Number(op.baseVersion || 0) !== Number(item.version || 0)) return conflict(op, item.version, item);
    incoming = JSON.parse(JSON.stringify(p.item || {}));
    delete incoming.stockEntries; delete incoming.quantity; delete incoming.version; delete incoming.createdAt; delete incoming.updatedAt; delete incoming.deletedAt;
    Object.keys(incoming).forEach(function(k) { if (k !== 'id') item[k] = incoming[k]; });
    item.version = Number(item.version || 0) + 1; item.updatedAt = now; item.quantity = recomputeItemQuantity(item);
    return resultFor(op, 'applied', { entityVersion: item.version });
  }

  if (op.type === 'ITEM_DELETE') {
    item = findItem(state, op.entityId);
    if (!item) return conflict(op, 0, null, 'ENTITY_NOT_FOUND');
    if (Number(op.baseVersion || 0) !== Number(item.version || 0)) return conflict(op, item.version, item);
    item.deletedAt = now; item.updatedAt = now; item.version = Number(item.version || 0) + 1;
    return resultFor(op, 'applied', { entityVersion: item.version });
  }

  if (op.type === 'STOCK_ENTRY_PUT') {
    item = findItem(state, p.itemId);
    if (!item || item.deletedAt) return resultFor(op, 'rejected', { errorCode: item ? 'ENTITY_DELETED' : 'ENTITY_NOT_FOUND' });
    entry = findEntry(item, op.entityId);
    if (!entry) {
      if (Number(op.baseVersion || 0) !== 0) return conflict(op, 0, null, 'ENTITY_NOT_FOUND');
      incoming = JSON.parse(JSON.stringify(p.entry || {}));
      incoming.id = op.entityId; incoming.quantity = Math.max(0, Number(p.initialQuantity || 0));
      incoming.version = 1; incoming.createdAt = now; incoming.updatedAt = now; incoming.hiddenAt = null;
      item.stockEntries = item.stockEntries || []; item.stockEntries.push(incoming);
      item.version = Number(item.version || 0) + 1; item.updatedAt = now; item.quantity = recomputeItemQuantity(item);
      return resultFor(op, 'applied', { entityVersion: 1 });
    }
    if (entry.hiddenAt) return conflict(op, entry.version, entry, 'ENTITY_DELETED');
    if (Number(op.baseVersion || 0) !== Number(entry.version || 0)) return conflict(op, entry.version, entry);
    incoming = JSON.parse(JSON.stringify(p.entry || {}));
    delete incoming.quantity; delete incoming.version; delete incoming.createdAt; delete incoming.updatedAt; delete incoming.hiddenAt;
    Object.keys(incoming).forEach(function(k) { if (k !== 'id') entry[k] = incoming[k]; });
    entry.version = Number(entry.version || 0) + 1; entry.updatedAt = now;
    item.version = Number(item.version || 0) + 1; item.updatedAt = now; item.quantity = recomputeItemQuantity(item);
    return resultFor(op, 'applied', { entityVersion: entry.version });
  }

  if (op.type === 'STOCK_ENTRY_DELETE') {
    item = findItem(state, p.itemId); entry = findEntry(item, p.entryId);
    if (!entry) return conflict(op, 0, null, 'ENTITY_NOT_FOUND');
    if (Number(op.baseVersion || 0) !== Number(entry.version || 0)) return conflict(op, entry.version, entry);
    entry.hiddenAt = now; entry.updatedAt = now; entry.version = Number(entry.version || 0) + 1;
    item.version = Number(item.version || 0) + 1; item.updatedAt = now; item.quantity = recomputeItemQuantity(item);
    return resultFor(op, 'applied', { entityVersion: entry.version });
  }

  if (op.type === 'STOCK_ADJUST') {
    item = findItem(state, p.itemId); entry = findEntry(item, p.entryId);
    if (!item || item.deletedAt || !entry || entry.hiddenAt) return resultFor(op, 'rejected', { errorCode: 'ENTITY_NOT_FOUND' });
    var delta = Number(p.delta);
    if (!isFinite(delta) || delta === 0) return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
    var next = Number(entry.quantity || 0) + delta;
    if (next < 0) return resultFor(op, 'rejected', { errorCode: 'INSUFFICIENT_STOCK' });
    entry.quantity = next; entry.version = Number(entry.version || 0) + 1; entry.updatedAt = now;
    item.version = Number(item.version || 0) + 1; item.updatedAt = now; item.quantity = recomputeItemQuantity(item);
    return resultFor(op, 'applied', { entityVersion: entry.version });
  }

  if (op.type === 'LOCATIONS_PUT') {
    version = Number(state.meta.locationsVersion || 0);
    if (Number(op.baseVersion || 0) !== version) return conflict(op, version, { segments: state.segments, coordinates: state.coordinates, spatialBackgroundImage: state.spatialBackgroundImage });
    state.segments = JSON.parse(JSON.stringify(p.segments || {})); state.coordinates = JSON.parse(JSON.stringify(p.coordinates || {})); state.spatialBackgroundImage = p.spatialBackgroundImage || null;
    state.meta.locationsVersion = version + 1; return resultFor(op, 'applied', { entityVersion: state.meta.locationsVersion });
  }

  if (op.type === 'CATEGORIES_PUT') {
    version = Number(state.meta.categoriesVersion || 0);
    if (Number(op.baseVersion || 0) !== version) return conflict(op, version, { categories: state.categories });
    state.categories = JSON.parse(JSON.stringify(p.categories || {})); state.meta.categoriesVersion = version + 1;
    return resultFor(op, 'applied', { entityVersion: state.meta.categoriesVersion });
  }

  if (op.type === 'HOUSEHOLD_SETTINGS_PUT') {
    version = Number(state.meta.householdSettingsVersion || 0);
    if (Number(op.baseVersion || 0) !== version) return conflict(op, version, { users: state.users, userEmails: state.userEmails, reminderDays: state.reminderDays });
    var users = Array.isArray(p.users) ? p.users.filter(function(v, i, a) { return v && a.indexOf(v) === i; }) : ['Default'];
    if (users.indexOf('Default') < 0) users.unshift('Default');
    state.users = users; state.userEmails = p.userEmails || {}; state.reminderDays = Math.max(1, Math.min(365, Number(p.reminderDays || 30)));
    state.meta.householdSettingsVersion = version + 1;
    return resultFor(op, 'applied', { entityVersion: state.meta.householdSettingsVersion });
  }

  return resultFor(op, 'rejected', { errorCode: 'UNKNOWN_OPERATION' });
}

function handleSyncPush(payload) {
  return withSyncLock(function() {
    var operations = Array.isArray(payload.operations) ? payload.operations : [];
    if (operations.length > CONFIG.maxOperations) return fail('PAYLOAD_TOO_LARGE', 'Too many operations in one push.', false);
    var meta = readMeta();
    if (!meta.initialized) return fail('SERVER_NOT_INITIALIZED', 'Cloud storage must be initialized first.', false);
    var state = loadCanonical(meta);
    var index = loadOperationIndex();
    var batchResults = {};
    var results = [];

    operations.forEach(function(op) {
      var validation = validateOperation(op);
      var hash = opHash(op || {});
      var existing = op && index[op.opId];
      var result;
      if (validation) result = resultFor(op || {}, 'rejected', { errorCode: validation });
      else if (existing) {
        result = existing.operationHash === hash ? resultFor(op, 'duplicate', {
          serverSeq: existing.serverSeq, entityVersion: existing.entityVersion, errorCode: existing.errorCode || undefined
        }) : resultFor(op, 'rejected', { errorCode: 'OP_ID_REUSE' });
      } else if (op.dependsOnOpId && (!batchResults[op.dependsOnOpId] && !index[op.dependsOnOpId] ||
                 batchResults[op.dependsOnOpId] && ['applied', 'duplicate'].indexOf(batchResults[op.dependsOnOpId].status) < 0 ||
                 index[op.dependsOnOpId] && ['applied', 'duplicate'].indexOf(index[op.dependsOnOpId].status) < 0)) {
        result = resultFor(op, 'blocked', { errorCode: 'DEPENDENCY_FAILED' });
      } else {
        result = applyOperation(state, meta, op);
        if (result.status === 'applied') {
          meta.serverSeq += 1;
          result.serverSeq = meta.serverSeq;
          state.meta.serverSeq = meta.serverSeq;
        }
      }
      results.push(result); batchResults[op && op.opId || ''] = result;
      if (!existing && op && op.opId) { appendOperation(op, hash, result); index[op.opId] = Object.assign({ operationHash: hash }, result); }
      if (result.status === 'rejected') writeDeadLetter(op, result.errorCode || 'INVALID_OPERATION');
    });

    state = writeCanonicalAtomically(state, meta);
    writeAudit(payload.deviceId || '', 'SYNC_PUSH', operations.length, true, '');
    return { success: true, serverSeq: meta.serverSeq, results: results, snapshot: state };
  });
}

function writeDeadLetter(op, reason) {
  var sheet = ensureSheet('DeadLetters', ['Timestamp', 'OpId', 'DeviceId', 'Type', 'RawJson', 'ErrorReason']);
  sheet.appendRow([new Date().toISOString(), op && op.opId || '', op && op.deviceId || '', op && op.type || '', JSON.stringify(op || {}), reason || '']);
}

function writeAudit(deviceId, action, count, success, errorCode) {
  var sheet = ensureSheet('SyncAudit', ['Timestamp', 'DeviceId', 'Action', 'OpsCount', 'Success', 'ErrorCode']);
  sheet.appendRow([new Date().toISOString(), deviceId, action, count, success ? 'true' : 'false', errorCode || '']);
}

function migrateLegacyDataToV3() {
  return withSyncLock(function() {
    var meta = readMeta();
    if (meta.initialized) throw new Error('SERVER_ALREADY_INITIALIZED');
    var legacy = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Data');
    var state = {};
    if (legacy && legacy.getLastRow() > 0) {
      var count = Number(legacy.getRange('B2').getValue() || legacy.getLastRow() || 1);
      var text = legacy.getRange(1, 1, count, 1).getValues().map(function(r) { return String(r[0] || ''); }).join('');
      if (text) state = JSON.parse(text);
      var backup = ensureSheet('Legacy_Data_Backup_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
      backup.getRange(1, 1, legacy.getDataRange().getNumRows(), legacy.getDataRange().getNumColumns()).setValues(legacy.getDataRange().getValues());
    }
    meta.serverSeq = Number(state.meta && state.meta.lastServerRevision || 0);
    state = writeCanonicalAtomically(normalizeSnapshot(state, meta.serverSeq), meta);
    Logger.log('Migration complete: ' + state.inventory.length + ' items, serverSeq=' + meta.serverSeq);
    return state;
  });
}

function setSyncSecret(secret) {
  if (!secret || String(secret).length < 16) throw new Error('Secret must contain at least 16 characters.');
  PropertiesService.getScriptProperties().setProperty(CONFIG.secretProperty, String(secret));
}

function handleImageUpload(req) {
  if (!req.data) return fail('INVALID_REQUEST', 'Missing image data.', false);
  var raw = req.data.replace(/^data:image\/\w+;base64,/, '');
  var blob = Utilities.newBlob(Utilities.base64Decode(raw), 'image/jpeg', req.fileName || ('item_' + Date.now() + '.jpg'));
  var folders = DriveApp.getFoldersByName('ItemPhotos');
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('ItemPhotos');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { success: true, fileId: file.getId(), url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1280' };
}

function handleSendReminders(req) {
  var groups = req.payload && req.payload.groups ? req.payload.groups : req.payload;
  if (!Array.isArray(groups)) return fail('INVALID_REQUEST', 'Reminder payload must be an array.', false);
  var sent = 0;
  groups.forEach(function(group) {
    if (!group || !group.email || !Array.isArray(group.items) || !group.items.length) return;
    var body = '<h2>Home inventory reminder</h2><ul>' + group.items.map(function(item) {
      return '<li><strong>' + String(item.name || '').replace(/[<>]/g, '') + '</strong></li>';
    }).join('') + '</ul>';
    MailApp.sendEmail({ to: group.email, subject: 'Home inventory reminder', htmlBody: body });
    sent += 1;
  });
  return { success: true, sent: sent, recipients: sent };
}
