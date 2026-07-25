/**
 * Home Inventory multi-device synchronization backend.
 *
 * Protocol v3 uses server-authoritative entity versions, immutable operation
 * IDs, explicit per-operation results, a script lock for all writes, and
 * checksum-verified double-buffered snapshots.
 */
var CONFIG = {
  protocolVersion: 3,
  schemaVersion: '3.0.0',
  maxCellSize: 40000,
  maxOperations: 100,
  maxRequestChars: 500000,
  maxTextLength: 10000,
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
  var rawBody = e.postData && e.postData.contents ? String(e.postData.contents) : '';
  if (rawBody.length > CONFIG.maxRequestChars) throw new Error('PAYLOAD_TOO_LARGE');
  var body = {};
  if (rawBody && /^\s*\{/.test(rawBody)) {
    try { body = JSON.parse(rawBody); } catch (ignore) {}
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
  var values = {};
  rows.forEach(function(row) { if (row[0]) values[String(row[0])] = String(row[1]); });
  return {
    protocolVersion: Number(values.protocolVersion || CONFIG.protocolVersion),
    schemaVersion: values.schemaVersion || CONFIG.schemaVersion,
    initialized: values.initialized === 'true',
    activeSlot: values.activeSlot || 'A',
    serverSeq: Number(values.serverSeq || 0),
    updatedAt: values.updatedAt || '',
    activeChecksum: values.activeChecksum || '',
    activeChunkCount: Number(values.activeChunkCount || 0)
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
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return digest.map(function(b) {
    var n = b < 0 ? b + 256 : b;
    return ('0' + n.toString(16)).slice(-2);
  }).join('');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).sort().forEach(function(key) { out[key] = stableValue(value[key]); });
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function finiteNumber(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

function boundedReminderDays(value) {
  var n = Math.floor(finiteNumber(value, 30));
  return Math.max(1, Math.min(365, n));
}

function normalizeSnapshot(input, serverSeq) {
  var state = input && typeof input === 'object' ? JSON.parse(JSON.stringify(input)) : {};
  state.protocolVersion = CONFIG.protocolVersion;
  state.schemaVersion = CONFIG.schemaVersion;
  state.meta = state.meta || {};
  state.meta.initialized = true;
  state.meta.serverSeq = Number(serverSeq || state.meta.serverSeq || 0);
  state.meta.locationsVersion = Math.max(0, Number(state.meta.locationsVersion || state.meta.structureVersion || 0));
  state.meta.categoriesVersion = Math.max(0, Number(state.meta.categoriesVersion || state.meta.categoryVersion || 0));
  state.meta.householdSettingsVersion = Math.max(0, Number(state.meta.householdSettingsVersion || 0));
  delete state.meta.deviceId;
  delete state.meta.lastLocalChangeAt;
  delete state.meta.lastChangeBy;
  delete state.meta.localSnapshotVersion;
  delete state.meta.lastPushedSnapshotVersion;
  delete state.meta.lastPulledServerSeq;

  state.segments = state.segments && typeof state.segments === 'object' ? state.segments : {};
  state.coordinates = state.coordinates && typeof state.coordinates === 'object' ? state.coordinates : {};
  state.spatialBackgroundImage = state.spatialBackgroundImage || null;
  state.categories = state.categories && typeof state.categories === 'object' ? state.categories : {};
  state.inventory = Array.isArray(state.inventory) ? state.inventory : [];
  state.users = Array.isArray(state.users) ? state.users.filter(function(v, i, a) {
    return typeof v === 'string' && v.trim() && a.indexOf(v) === i;
  }) : [];
  if (state.users.indexOf('Default') < 0) state.users.unshift('Default');
  state.userEmails = state.userEmails && typeof state.userEmails === 'object' ? state.userEmails : {};
  Object.keys(state.userEmails).forEach(function(key) {
    if (typeof state.userEmails[key] !== 'string') delete state.userEmails[key];
  });
  state.reminderDays = boundedReminderDays(state.reminderDays);
  delete state.syncQueue;
  delete state.syncConflicts;
  delete state.currentUser;
  delete state.language;
  delete state.reminderLog;

  var now = new Date().toISOString();
  state.inventory = state.inventory.filter(function(item) { return item && item.id; });
  state.inventory.forEach(function(item) {
    item.version = Math.max(1, Math.floor(finiteNumber(item.version, 1)));
    item.createdAt = item.createdAt || item.timestamp || now;
    item.updatedAt = item.updatedAt || item.createdAt;
    item.deletedAt = item.deletedAt || null;
    item.stockEntries = Array.isArray(item.stockEntries) ? item.stockEntries.filter(function(entry) { return entry && entry.id; }) : [];
    item.stockEntries.forEach(function(entry) {
      entry.version = Math.max(1, Math.floor(finiteNumber(entry.version, 1)));
      entry.quantity = Math.max(0, finiteNumber(entry.quantity, 0));
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
  var text = values.map(function(row) { return String(row[0] || ''); }).join('');
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
  state.meta.serverSeq = meta.serverSeq;
  state.meta.updatedAt = new Date().toISOString();
  var text = JSON.stringify(state);
  var count = Math.max(1, Math.ceil(text.length / CONFIG.maxCellSize));
  var sheet = ensureSheet('Data_' + inactive);
  sheet.clearContents();
  var rows = [];
  for (var i = 0; i < count; i++) {
    rows.push([text.substring(i * CONFIG.maxCellSize, (i + 1) * CONFIG.maxCellSize)]);
  }
  sheet.getRange(1, 1, rows.length, 1).setValues(rows);
  SpreadsheetApp.flush();

  var verify = sheet.getRange(1, 1, count, 1).getValues().map(function(row) { return String(row[0] || ''); }).join('');
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

function withSyncLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return fail('SERVER_BUSY', 'Synchronization is temporarily busy.', true);
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function handleSyncPull() {
  var meta = readMeta();
  if (!meta.initialized) return { success: true, initialized: false, serverSeq: 0, snapshot: null };
  return { success: true, initialized: true, serverSeq: meta.serverSeq, snapshot: loadCanonical(meta) };
}

function handleSyncBootstrap(payload) {
  payload = payload || {};
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
  return ensureSheet('Ops', [
    'serverSeq', 'opId', 'operationHash', 'deviceId', 'type', 'entityType',
    'entityId', 'status', 'errorCode', 'entityVersion', 'timestamp', 'json'
  ]);
}

function loadOperationIndex() {
  var sheet = ensureOpsSheet();
  var out = {};
  if (sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 12).getValues().forEach(function(row) {
    var extra = {};
    try { extra = JSON.parse(row[11] || '{}'); } catch (ignore) {}
    out[String(row[1])] = {
      serverSeq: Number(row[0] || 0),
      opId: String(row[1] || ''),
      operationHash: String(row[2] || ''),
      deviceId: String(row[3] || ''),
      type: String(row[4] || ''),
      entityType: String(row[5] || ''),
      entityId: String(row[6] || ''),
      status: String(row[7] || ''),
      errorCode: String(row[8] || ''),
      entityVersion: Number(row[9] || 0),
      timestamp: String(row[10] || ''),
      expectedVersion: extra.expectedVersion,
      actualVersion: extra.actualVersion,
      serverEntity: extra.serverEntity,
      message: extra.message
    };
  });
  return out;
}

function opHash(op) {
  return checksum(stableStringify({
    opId: op.opId,
    type: op.type,
    entityType: op.entityType,
    entityId: op.entityId,
    baseVersion: Number(op.baseVersion || 0),
    dependsOnOpId: op.dependsOnOpId || null,
    deviceId: op.deviceId || '',
    createdAt: op.createdAt || '',
    localOrder: Number(op.localOrder || 0),
    payload: op.payload || {}
  }));
}

function appendOperation(op, hash, result) {
  ensureOpsSheet().appendRow([
    result.serverSeq || '', op.opId || '', hash, op.deviceId || '', op.type || '',
    op.entityType || '', op.entityId || '', result.status || '', result.errorCode || '',
    result.entityVersion || '', new Date().toISOString(), JSON.stringify({
      expectedVersion: result.expectedVersion,
      actualVersion: result.actualVersion,
      serverEntity: result.serverEntity || null,
      message: result.message || ''
    })
  ]);
}

function resultFor(op, status, extra) {
  var out = {
    opId: op && op.opId || '',
    status: status,
    entityType: op && op.entityType || '',
    entityId: op && op.entityId || ''
  };
  Object.keys(extra || {}).forEach(function(key) { out[key] = extra[key]; });
  return out;
}

function storedResult(op, existing, statusOverride) {
  return resultFor(op, statusOverride || existing.status, {
    serverSeq: existing.serverSeq || undefined,
    entityVersion: existing.entityVersion || undefined,
    errorCode: existing.errorCode || undefined,
    expectedVersion: existing.expectedVersion,
    actualVersion: existing.actualVersion,
    serverEntity: existing.serverEntity,
    message: existing.message || undefined
  });
}

/**
 * Returns a prior conclusive result, or null when an "applied" receipt belongs
 * to a failed pre-commit attempt and the operation must be applied again.
 */
function resolveExistingOperation(op, hash, existing, committedServerSeq) {
  if (!existing) return null;
  if (existing.operationHash !== hash) return resultFor(op, 'rejected', { errorCode: 'OP_ID_REUSE' });
  if (existing.status === 'applied') {
    if (existing.serverSeq > 0 && existing.serverSeq <= committedServerSeq) {
      return storedResult(op, existing, 'duplicate');
    }
    return null;
  }
  return storedResult(op, existing, existing.status || 'rejected');
}

function dependencySucceeded(opId, batchResults, operationIndex, committedServerSeq) {
  if (!opId) return true;
  if (batchResults[opId]) {
    return ['applied', 'duplicate'].indexOf(batchResults[opId].status) >= 0;
  }
  var existing = operationIndex[opId];
  return !!existing && existing.status === 'applied' && existing.serverSeq > 0 && existing.serverSeq <= committedServerSeq;
}

function validateTextLengths(value) {
  if (typeof value === 'string') return value.length <= CONFIG.maxTextLength;
  if (Array.isArray(value)) return value.every(validateTextLengths);
  if (value && typeof value === 'object') {
    return Object.keys(value).every(function(key) {
      return key.length <= 200 && validateTextLengths(value[key]);
    });
  }
  return true;
}

function validateOperation(op) {
  if (!op || !op.opId || !op.type || !op.entityType || !op.entityId) return 'INVALID_OPERATION';
  var allowed = [
    'ITEM_PUT', 'ITEM_DELETE', 'STOCK_ENTRY_PUT', 'STOCK_ENTRY_DELETE',
    'STOCK_ADJUST', 'LOCATIONS_PUT', 'CATEGORIES_PUT', 'HOUSEHOLD_SETTINGS_PUT'
  ];
  if (allowed.indexOf(op.type) < 0) return 'UNKNOWN_OPERATION';
  if (!validateTextLengths(op.payload || {})) return 'PAYLOAD_TOO_LARGE';
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
    return entry && !entry.hiddenAt ? sum + finiteNumber(entry.quantity, 0) : sum;
  }, 0);
}

function conflict(op, actualVersion, serverEntity, code) {
  return resultFor(op, 'conflict', {
    errorCode: code || 'VERSION_CONFLICT',
    expectedVersion: Number(op.baseVersion || 0),
    actualVersion: Number(actualVersion || 0),
    serverEntity: JSON.parse(JSON.stringify(serverEntity || null))
  });
}

function applyOperation(state, op) {
  var payload = op.payload || {};
  var now = new Date().toISOString();
  var item;
  var entry;
  var incoming;
  var version;

  if (op.type === 'ITEM_PUT') {
    item = findItem(state, op.entityId);
    incoming = payload.item || {};
    if (!incoming.id || incoming.id !== op.entityId) return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
    if (!item) {
      if (Number(op.baseVersion || 0) !== 0) return conflict(op, 0, null, 'ENTITY_NOT_FOUND');
      incoming = JSON.parse(JSON.stringify(incoming));
      delete incoming.stockEntries;
      delete incoming.quantity;
      delete incoming.version;
      delete incoming.createdAt;
      delete incoming.updatedAt;
      delete incoming.deletedAt;
      incoming.version = 1;
      incoming.createdAt = now;
      incoming.updatedAt = now;
      incoming.deletedAt = null;
      incoming.stockEntries = [];
      state.inventory.push(incoming);
      return resultFor(op, 'applied', { entityVersion: 1 });
    }
    if (item.deletedAt) return conflict(op, item.version, item, 'ENTITY_DELETED');
    if (Number(op.baseVersion || 0) !== Number(item.version || 0)) return conflict(op, item.version, item);
    incoming = JSON.parse(JSON.stringify(incoming));
    delete incoming.stockEntries;
    delete incoming.quantity;
    delete incoming.version;
    delete incoming.createdAt;
    delete incoming.updatedAt;
    delete incoming.deletedAt;
    Object.keys(incoming).forEach(function(key) { if (key !== 'id') item[key] = incoming[key]; });
    item.version = Number(item.version || 0) + 1;
    item.updatedAt = now;
    item.quantity = recomputeItemQuantity(item);
    return resultFor(op, 'applied', { entityVersion: item.version });
  }

  if (op.type === 'ITEM_DELETE') {
    item = findItem(state, op.entityId);
    if (!item) return conflict(op, 0, null, 'ENTITY_NOT_FOUND');
    if (item.deletedAt) return conflict(op, item.version, item, 'ENTITY_DELETED');
    if (Number(op.baseVersion || 0) !== Number(item.version || 0)) return conflict(op, item.version, item);
    item.deletedAt = now;
    item.updatedAt = now;
    item.version = Number(item.version || 0) + 1;
    return resultFor(op, 'applied', { entityVersion: item.version });
  }

  if (op.type === 'STOCK_ENTRY_PUT') {
    item = findItem(state, payload.itemId);
    if (!item) return resultFor(op, 'rejected', { errorCode: 'ENTITY_NOT_FOUND' });
    if (item.deletedAt) return resultFor(op, 'rejected', { errorCode: 'ENTITY_DELETED' });
    incoming = payload.entry || {};
    if (!incoming.id || incoming.id !== op.entityId) return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
    entry = findEntry(item, op.entityId);
    if (!entry) {
      if (Number(op.baseVersion || 0) !== 0) return conflict(op, 0, null, 'ENTITY_NOT_FOUND');
      var initialQuantity = Number(payload.initialQuantity || 0);
      if (!isFinite(initialQuantity) || initialQuantity < 0) return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
      incoming = JSON.parse(JSON.stringify(incoming));
      delete incoming.quantity;
      delete incoming.version;
      delete incoming.createdAt;
      delete incoming.updatedAt;
      delete incoming.hiddenAt;
      incoming.id = op.entityId;
      incoming.quantity = initialQuantity;
      incoming.version = 1;
      incoming.createdAt = now;
      incoming.updatedAt = now;
      incoming.hiddenAt = null;
      item.stockEntries = item.stockEntries || [];
      item.stockEntries.push(incoming);
      item.version = Number(item.version || 0) + 1;
      item.updatedAt = now;
      item.quantity = recomputeItemQuantity(item);
      return resultFor(op, 'applied', { entityVersion: 1 });
    }
    if (entry.hiddenAt) return conflict(op, entry.version, entry, 'ENTITY_DELETED');
    if (Number(op.baseVersion || 0) !== Number(entry.version || 0)) return conflict(op, entry.version, entry);
    incoming = JSON.parse(JSON.stringify(incoming));
    delete incoming.quantity;
    delete incoming.version;
    delete incoming.createdAt;
    delete incoming.updatedAt;
    delete incoming.hiddenAt;
    Object.keys(incoming).forEach(function(key) { if (key !== 'id') entry[key] = incoming[key]; });
    entry.version = Number(entry.version || 0) + 1;
    entry.updatedAt = now;
    item.version = Number(item.version || 0) + 1;
    item.updatedAt = now;
    item.quantity = recomputeItemQuantity(item);
    return resultFor(op, 'applied', { entityVersion: entry.version });
  }

  if (op.type === 'STOCK_ENTRY_DELETE') {
    item = findItem(state, payload.itemId);
    if (!item) return conflict(op, 0, null, 'ENTITY_NOT_FOUND');
    if (item.deletedAt) return conflict(op, item.version, item, 'ENTITY_DELETED');
    entry = findEntry(item, payload.entryId);
    if (!entry) return conflict(op, 0, null, 'ENTITY_NOT_FOUND');
    if (entry.hiddenAt) return conflict(op, entry.version, entry, 'ENTITY_DELETED');
    if (Number(op.baseVersion || 0) !== Number(entry.version || 0)) return conflict(op, entry.version, entry);
    entry.hiddenAt = now;
    entry.updatedAt = now;
    entry.version = Number(entry.version || 0) + 1;
    item.version = Number(item.version || 0) + 1;
    item.updatedAt = now;
    item.quantity = recomputeItemQuantity(item);
    return resultFor(op, 'applied', { entityVersion: entry.version });
  }

  if (op.type === 'STOCK_ADJUST') {
    item = findItem(state, payload.itemId);
    if (!item) return resultFor(op, 'rejected', { errorCode: 'ENTITY_NOT_FOUND' });
    if (item.deletedAt) return resultFor(op, 'rejected', { errorCode: 'ENTITY_DELETED' });
    entry = findEntry(item, payload.entryId);
    if (!entry) return resultFor(op, 'rejected', { errorCode: 'ENTITY_NOT_FOUND' });
    if (entry.hiddenAt) return resultFor(op, 'rejected', { errorCode: 'ENTITY_DELETED' });
    var delta = Number(payload.delta);
    if (!isFinite(delta) || delta === 0) return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
    var nextQuantity = Number(entry.quantity || 0) + delta;
    if (nextQuantity < 0) return resultFor(op, 'rejected', { errorCode: 'INSUFFICIENT_STOCK' });
    entry.quantity = nextQuantity;
    entry.version = Number(entry.version || 0) + 1;
    entry.updatedAt = now;
    item.version = Number(item.version || 0) + 1;
    item.updatedAt = now;
    item.quantity = recomputeItemQuantity(item);
    return resultFor(op, 'applied', { entityVersion: entry.version });
  }

  if (op.type === 'LOCATIONS_PUT') {
    version = Number(state.meta.locationsVersion || 0);
    if (Number(op.baseVersion || 0) !== version) {
      return conflict(op, version, {
        segments: state.segments,
        coordinates: state.coordinates,
        spatialBackgroundImage: state.spatialBackgroundImage
      });
    }
    if (!payload.segments || typeof payload.segments !== 'object' || !payload.coordinates || typeof payload.coordinates !== 'object') {
      return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
    }
    state.segments = JSON.parse(JSON.stringify(payload.segments));
    state.coordinates = JSON.parse(JSON.stringify(payload.coordinates));
    state.spatialBackgroundImage = payload.spatialBackgroundImage || null;
    state.meta.locationsVersion = version + 1;
    return resultFor(op, 'applied', { entityVersion: state.meta.locationsVersion });
  }

  if (op.type === 'CATEGORIES_PUT') {
    version = Number(state.meta.categoriesVersion || 0);
    if (Number(op.baseVersion || 0) !== version) return conflict(op, version, { categories: state.categories });
    if (!payload.categories || typeof payload.categories !== 'object') return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
    state.categories = JSON.parse(JSON.stringify(payload.categories));
    state.meta.categoriesVersion = version + 1;
    return resultFor(op, 'applied', { entityVersion: state.meta.categoriesVersion });
  }

  if (op.type === 'HOUSEHOLD_SETTINGS_PUT') {
    version = Number(state.meta.householdSettingsVersion || 0);
    if (Number(op.baseVersion || 0) !== version) {
      return conflict(op, version, {
        users: state.users,
        userEmails: state.userEmails,
        reminderDays: state.reminderDays
      });
    }
    var users = Array.isArray(payload.users) ? payload.users.filter(function(value, index, array) {
      return typeof value === 'string' && value.trim() && array.indexOf(value) === index;
    }) : [];
    if (users.indexOf('Default') < 0) users.unshift('Default');
    var emails = payload.userEmails && typeof payload.userEmails === 'object' ? JSON.parse(JSON.stringify(payload.userEmails)) : {};
    var invalidEmailValue = Object.keys(emails).some(function(key) { return typeof emails[key] !== 'string'; });
    if (invalidEmailValue) return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
    var days = Number(payload.reminderDays);
    if (!isFinite(days) || days < 1 || days > 365 || Math.floor(days) !== days) {
      return resultFor(op, 'rejected', { errorCode: 'INVALID_OPERATION' });
    }
    state.users = users;
    state.userEmails = emails;
    state.reminderDays = days;
    state.meta.householdSettingsVersion = version + 1;
    return resultFor(op, 'applied', { entityVersion: state.meta.householdSettingsVersion });
  }

  return resultFor(op, 'rejected', { errorCode: 'UNKNOWN_OPERATION' });
}

function handleSyncPush(payload) {
  payload = payload || {};
  return withSyncLock(function() {
    var operations = Array.isArray(payload.operations) ? payload.operations : [];
    if (operations.length > CONFIG.maxOperations) return fail('PAYLOAD_TOO_LARGE', 'Too many operations in one push.', false);

    var meta = readMeta();
    if (!meta.initialized) return fail('SERVER_NOT_INITIALIZED', 'Cloud storage must be initialized first.', false);
    var state = loadCanonical(meta);
    var committedServerSeq = meta.serverSeq;
    var operationIndex = loadOperationIndex();
    var batchResults = {};
    var results = [];
    var appliedCount = 0;

    for (var i = 0; i < operations.length; i++) {
      var op = operations[i] || {};
      var validation = validateOperation(op);
      var hash = opHash(op);
      var result;

      if (validation) {
        result = resultFor(op, 'rejected', { errorCode: validation });
      } else {
        result = resolveExistingOperation(op, hash, operationIndex[op.opId], committedServerSeq);
        if (!result && op.dependsOnOpId && !dependencySucceeded(op.dependsOnOpId, batchResults, operationIndex, committedServerSeq)) {
          result = resultFor(op, 'blocked', { errorCode: 'DEPENDENCY_FAILED' });
        }
        if (!result) {
          result = applyOperation(state, op);
          if (result.status === 'applied') {
            meta.serverSeq += 1;
            state.meta.serverSeq = meta.serverSeq;
            result.serverSeq = meta.serverSeq;
            appliedCount += 1;
          }
          // Receipt is intentionally written before the snapshot. If the later
          // atomic snapshot commit fails, resolveExistingOperation detects that
          // result.serverSeq is newer than committedServerSeq and reapplies it.
          appendOperation(op, hash, result);
          operationIndex[op.opId] = Object.assign({ operationHash: hash }, result);
        }
      }

      results.push(result);
      if (op.opId) batchResults[op.opId] = result;
      if (result.status === 'rejected') {
        try { writeDeadLetter(op, result.errorCode || 'INVALID_OPERATION'); } catch (ignore) {}
      }
    }

    if (appliedCount > 0) state = writeCanonicalAtomically(state, meta);
    writeAudit(payload.deviceId || '', 'SYNC_PUSH', operations.length, true, '');
    return { success: true, serverSeq: meta.serverSeq, results: results, snapshot: state };
  });
}

function writeDeadLetter(op, reason) {
  ensureSheet('DeadLetters', ['Timestamp', 'OpId', 'DeviceId', 'Type', 'RawJson', 'ErrorReason'])
    .appendRow([
      new Date().toISOString(), op && op.opId || '', op && op.deviceId || '',
      op && op.type || '', JSON.stringify(op || {}), reason || ''
    ]);
}

function writeAudit(deviceId, action, count, success, errorCode) {
  ensureSheet('SyncAudit', ['Timestamp', 'DeviceId', 'Action', 'OpsCount', 'Success', 'ErrorCode'])
    .appendRow([new Date().toISOString(), deviceId, action, count, success ? 'true' : 'false', errorCode || '']);
}

function migrateLegacyDataToV3() {
  return withSyncLock(function() {
    var meta = readMeta();
    if (meta.initialized) throw new Error('SERVER_ALREADY_INITIALIZED');
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var legacy = ss.getSheetByName('Data');
    var state = {};
    if (legacy && legacy.getLastRow() > 0) {
      var count = Number(legacy.getRange('B2').getValue() || legacy.getLastRow() || 1);
      var text = legacy.getRange(1, 1, count, 1).getValues().map(function(row) { return String(row[0] || ''); }).join('');
      if (text) state = JSON.parse(text);
      var backupName = 'Legacy_Data_Backup_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
      var backup = ensureSheet(backupName);
      var range = legacy.getDataRange();
      backup.getRange(1, 1, range.getNumRows(), range.getNumColumns()).setValues(range.getValues());
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

function ensureReminderSheet() {
  return ensureSheet('Reminders', ['Key', 'SentAt', 'Recipient']);
}

function loadReminderKeys() {
  var sheet = ensureReminderSheet();
  var out = {};
  if (sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(function(row) {
    if (row[0]) out[String(row[0])] = true;
  });
  return out;
}

function recordReminderKeys(keys, recipient) {
  if (!keys || !keys.length) return;
  var rows = keys.map(function(key) { return [key, new Date().toISOString(), recipient || '']; });
  var sheet = ensureReminderSheet();
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function handleSendReminders(req) {
  var groups = req.payload && req.payload.groups ? req.payload.groups : req.payload;
  if (!Array.isArray(groups)) return fail('INVALID_REQUEST', 'Reminder payload must be an array.', false);
  var known = loadReminderKeys();
  var sent = 0;
  groups.forEach(function(group) {
    if (!group || typeof group.email !== 'string' || !Array.isArray(group.items) || !group.items.length) return;
    var keys = Array.isArray(group.dedupeKeys) ? group.dedupeKeys.filter(Boolean).map(String) : [];
    if (keys.length && keys.every(function(key) { return known[key]; })) return;
    var body = '<h2>Home inventory reminder</h2><ul>' + group.items.map(function(item) {
      var suffix = item.quantity != null ? ' — quantity ' + escapeHtml(item.quantity) : '';
      return '<li><strong>' + escapeHtml(item.name || '') + '</strong>' + suffix + '</li>';
    }).join('') + '</ul>';
    MailApp.sendEmail({ to: group.email, subject: 'Home inventory reminder', htmlBody: body });
    recordReminderKeys(keys, group.email);
    keys.forEach(function(key) { known[key] = true; });
    sent += 1;
  });
  return { success: true, sent: sent, recipients: sent };
}

function daysUntil(dateValue) {
  if (!dateValue) return null;
  var target = new Date(String(dateValue) + (String(dateValue).length === 10 ? 'T00:00:00' : ''));
  if (isNaN(target.getTime())) return null;
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  return Math.floor((target.getTime() - today.getTime()) / 86400000);
}

function buildScheduledReminderGroups(state) {
  var groups = {};
  var reminderDays = boundedReminderDays(state.reminderDays);
  (state.inventory || []).forEach(function(item) {
    if (!item || item.deletedAt) return;
    var owner = item.owner || 'Default';
    var email = state.userEmails && state.userEmails[owner];
    if (!email) return;
    var due = false;
    var keys = [];
    if (item.itemType === 'stock') {
      var total = recomputeItemQuantity(item);
      if (Number(item.minQuantity || 0) > 0 && total <= Number(item.minQuantity || 0)) {
        due = true;
        keys.push('low::' + item.id + '::' + total + '::' + Number(item.minQuantity || 0));
      }
      (item.stockEntries || []).forEach(function(entry) {
        if (!entry || entry.hiddenAt) return;
        var remaining = daysUntil(entry.expiryDate);
        if (remaining != null && remaining <= reminderDays) {
          due = true;
          keys.push('expiry::' + item.id + '::' + entry.id + '::' + entry.expiryDate);
        }
      });
    } else {
      var remainingUnique = daysUntil(item.expiryDate);
      if (remainingUnique != null && remainingUnique <= reminderDays) {
        due = true;
        keys.push('expiry::' + item.id + '::unique::' + item.expiryDate);
      }
    }
    if (!due) return;
    if (!groups[email]) groups[email] = { email: email, owner: owner, items: [], dedupeKeys: [] };
    groups[email].items.push({ name: item.name, quantity: item.itemType === 'stock' ? recomputeItemQuantity(item) : undefined });
    groups[email].dedupeKeys = groups[email].dedupeKeys.concat(keys);
  });
  return Object.keys(groups).map(function(email) { return groups[email]; });
}

function checkAndRemind() {
  var meta = readMeta();
  if (!meta.initialized) return { success: true, sent: 0, recipients: 0 };
  var state = loadCanonical(meta);
  return handleSendReminders({ payload: buildScheduledReminderGroups(state) });
}

function setupTimeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'checkAndRemind') ScriptApp.deleteTrigger(trigger);
  });
  return ScriptApp.newTrigger('checkAndRemind').timeBased().everyDays(1).atHour(7).create();
}
