#!/usr/bin/env python3
"""One-time patch for exact sync commit tracking and server write hardening."""
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


backend_path = Path("GoogleSheetSync.gs")
backend = backend_path.read_text(encoding="utf-8")
if "committedOperationHashes" in backend:
    print("Exact committed-operation tracking is already present; nothing to patch.")
    raise SystemExit(0)

backend = replace_once(
    backend,
    "  maxRequestChars: 500000,\n  maxTextLength: 10000,",
    "  maxRequestChars: 500000,\n  maxImageRequestChars: 8000000,\n  maxTextLength: 10000,",
    "CONFIG image limit",
)

backend = replace_once(
    backend,
    "  var rawBody = e.postData && e.postData.contents ? String(e.postData.contents) : '';\n  if (rawBody.length > CONFIG.maxRequestChars) throw new Error('PAYLOAD_TOO_LARGE');",
    "  var rawBody = e.postData && e.postData.contents ? String(e.postData.contents) : '';\n  var hintedAction = String(p.action || '');\n  var requestLimit = hintedAction === 'IMAGE_UPLOAD' ? CONFIG.maxImageRequestChars : CONFIG.maxRequestChars;\n  if (rawBody.length > requestLimit) throw new Error('PAYLOAD_TOO_LARGE');",
    "request size selection",
)

backend = replace_once(
    backend,
    "  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).clearContent();\n  sheet.getRange(2, 1, rows.length, 2).setValues(rows);",
    "  var previousLastRow = sheet.getLastRow();\n  // Write the replacement pointer first. If setValues fails, the previous\n  // active snapshot metadata remains readable instead of being cleared.\n  sheet.getRange(2, 1, rows.length, 2).setValues(rows);\n  if (previousLastRow > rows.length + 1) {\n    sheet.getRange(rows.length + 2, 1, previousLastRow - rows.length - 1, 2).clearContent();\n  }",
    "metadata write ordering",
)

backend = replace_once(
    backend,
    "  state.meta.householdSettingsVersion = Math.max(0, Number(state.meta.householdSettingsVersion || 0));\n  delete state.meta.deviceId;",
    "  state.meta.householdSettingsVersion = Math.max(0, Number(state.meta.householdSettingsVersion || 0));\n\n  // Exact committed-operation hashes are part of the canonical snapshot.\n  // Server sequence numbers can be reused after a failed pre-commit attempt,\n  // so sequence comparison alone cannot prove that a receipt was committed.\n  var rawCommittedHashes = state.meta.committedOperationHashes;\n  var committedHashes = {};\n  if (rawCommittedHashes && typeof rawCommittedHashes === 'object' && !Array.isArray(rawCommittedHashes)) {\n    Object.keys(rawCommittedHashes).forEach(function(opId) {\n      var hash = rawCommittedHashes[opId];\n      if (opId && opId.length <= 300 && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) {\n        committedHashes[opId] = hash;\n      }\n    });\n  }\n  state.meta.committedOperationHashes = committedHashes;\n\n  delete state.meta.deviceId;",
    "canonical committed hashes",
)

backend = replace_once(
    backend,
    "function loadCanonical(meta) {\n  if (!meta.initialized) return null;\n  return normalizeSnapshot(readSlot(meta.activeSlot, meta.activeChunkCount, meta.activeChecksum), meta.serverSeq);\n}\n",
    "function loadCanonical(meta) {\n  if (!meta.initialized) return null;\n  return normalizeSnapshot(readSlot(meta.activeSlot, meta.activeChunkCount, meta.activeChecksum), meta.serverSeq);\n}\n\nfunction clientSnapshot(state) {\n  var copy = JSON.parse(JSON.stringify(state || {}));\n  if (copy.meta) delete copy.meta.committedOperationHashes;\n  return copy;\n}\n",
    "client snapshot helper",
)

backend = replace_once(
    backend,
    "  return { success: true, initialized: true, serverSeq: meta.serverSeq, snapshot: loadCanonical(meta) };",
    "  return { success: true, initialized: true, serverSeq: meta.serverSeq, snapshot: clientSnapshot(loadCanonical(meta)) };",
    "pull client snapshot",
)

backend = replace_once(
    backend,
    "    var state = normalizeSnapshot(payload.snapshot || {}, 0);\n    meta.serverSeq = 0;\n    state = writeCanonicalAtomically(state, meta);\n    writeAudit(payload.deviceId || '', 'SYNC_BOOTSTRAP', 0, true, '');\n    return { success: true, initialized: true, serverSeq: 0, snapshot: state };",
    "    var state = normalizeSnapshot(payload.snapshot || {}, 0);\n    // A client must never be able to predeclare operation IDs as committed.\n    state.meta.committedOperationHashes = {};\n    meta.serverSeq = 0;\n    state = writeCanonicalAtomically(state, meta);\n    writeAudit(payload.deviceId || '', 'SYNC_BOOTSTRAP', 0, true, '');\n    return { success: true, initialized: true, serverSeq: 0, snapshot: clientSnapshot(state) };",
    "bootstrap committed hashes",
)

backend = replace_once(
    backend,
    """/**
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
""",
    """/**
 * A receipt is conclusive only when the canonical snapshot contains the exact
 * immutable operation hash. Sequence comparison is insufficient because an
 * uncommitted sequence can later be reused by a different successful batch.
 */
function resolveExistingOperation(op, hash, existing, committedOperationHashes) {
  var committedHash = committedOperationHashes && committedOperationHashes[op.opId];
  if (committedHash) {
    if (committedHash !== hash) return resultFor(op, 'rejected', { errorCode: 'OP_ID_REUSE' });
    return existing ? storedResult(op, existing, 'duplicate') : resultFor(op, 'duplicate');
  }
  if (!existing) return null;
  if (existing.operationHash !== hash) return resultFor(op, 'rejected', { errorCode: 'OP_ID_REUSE' });
  if (existing.status === 'applied') {
    // Prepared receipt whose state was not committed: reapply from the current
    // canonical snapshot. A later successful batch cannot make it look committed.
    return null;
  }
  return storedResult(op, existing, existing.status || 'rejected');
}

function dependencySucceeded(opId, batchResults, committedOperationHashes) {
  if (!opId) return true;
  if (batchResults[opId]) {
    return ['applied', 'duplicate'].indexOf(batchResults[opId].status) >= 0;
  }
  return !!(committedOperationHashes && committedOperationHashes[opId]);
}
""",
    "receipt resolution",
)

backend = replace_once(
    backend,
    "    var state = loadCanonical(meta);\n    var committedServerSeq = meta.serverSeq;\n    var operationIndex = loadOperationIndex();",
    "    var state = loadCanonical(meta);\n    var committedOperationHashes = state.meta.committedOperationHashes || {};\n    var operationIndex = loadOperationIndex();",
    "push committed map",
)

backend = replace_once(
    backend,
    "        result = resolveExistingOperation(op, hash, operationIndex[op.opId], committedServerSeq);\n        if (!result && op.dependsOnOpId && !dependencySucceeded(op.dependsOnOpId, batchResults, operationIndex, committedServerSeq)) {",
    "        result = resolveExistingOperation(op, hash, operationIndex[op.opId], committedOperationHashes);\n        if (!result && op.dependsOnOpId && !dependencySucceeded(op.dependsOnOpId, batchResults, committedOperationHashes)) {",
    "push receipt calls",
)

backend = replace_once(
    backend,
    "            result.serverSeq = meta.serverSeq;\n            appliedCount += 1;\n          }\n          // Receipt is intentionally written before the snapshot. If the later\n          // atomic snapshot commit fails, resolveExistingOperation detects that\n          // result.serverSeq is newer than committedServerSeq and reapplies it.",
    "            result.serverSeq = meta.serverSeq;\n            committedOperationHashes[op.opId] = hash;\n            state.meta.committedOperationHashes = committedOperationHashes;\n            appliedCount += 1;\n          }\n          // The receipt is written before the snapshot for diagnostics. Only\n          // the exact hash set inside the canonical snapshot proves commitment.",
    "record committed hash",
)

backend = replace_once(
    backend,
    "    return { success: true, serverSeq: meta.serverSeq, results: results, snapshot: state };",
    "    return { success: true, serverSeq: meta.serverSeq, results: results, snapshot: clientSnapshot(state) };",
    "push client snapshot",
)

backend = replace_once(
    backend,
    "    meta.serverSeq = Number(state.meta && state.meta.lastServerRevision || 0);\n    state = writeCanonicalAtomically(normalizeSnapshot(state, meta.serverSeq), meta);",
    "    meta.serverSeq = Number(state.meta && state.meta.lastServerRevision || 0);\n    state = normalizeSnapshot(state, meta.serverSeq);\n    state.meta.committedOperationHashes = {};\n    state = writeCanonicalAtomically(state, meta);",
    "legacy migration committed map",
)

old_reminders = """function handleSendReminders(req) {
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
"""
new_reminders = """function sendRemindersUnlocked(req) {
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

function handleSendReminders(req) {
  return withSyncLock(function() { return sendRemindersUnlocked(req); });
}
"""
backend = replace_once(backend, old_reminders, new_reminders, "reminder locking")

backend = replace_once(
    backend,
    "function checkAndRemind() {\n  var meta = readMeta();\n  if (!meta.initialized) return { success: true, sent: 0, recipients: 0 };\n  var state = loadCanonical(meta);\n  return handleSendReminders({ payload: buildScheduledReminderGroups(state) });\n}",
    "function checkAndRemind() {\n  return withSyncLock(function() {\n    var meta = readMeta();\n    if (!meta.initialized) return { success: true, sent: 0, recipients: 0 };\n    var state = loadCanonical(meta);\n    return sendRemindersUnlocked({ payload: buildScheduledReminderGroups(state) });\n  });\n}",
    "scheduled reminder locking",
)

backend_path.write_text(backend, encoding="utf-8")

# Replace the receipt tests with exact canonical membership tests.
test_path = Path("tests/google-sheet-sync-v3.test.js")
test_text = test_path.read_text(encoding="utf-8")n
old_tests = """test('committed applied receipts become duplicates', function() {
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
"""
new_tests = """test('canonical operation hash makes an applied receipt a duplicate', function() {
  const operation = op({ type: 'ITEM_DELETE', baseVersion: 4 });
  const hash = context.opHash(operation);
  const existing = { operationHash: hash, status: 'applied', serverSeq: 8, entityVersion: 5 };
  const committed = { [operation.opId]: hash };
  const result = context.resolveExistingOperation(operation, hash, existing, committed);
  assert.equal(result.status, 'duplicate');
});

test('canonical operation hash works even when the audit receipt is missing', function() {
  const operation = op({ type: 'ITEM_DELETE', baseVersion: 4 });
  const hash = context.opHash(operation);
  const result = context.resolveExistingOperation(operation, hash, null, { [operation.opId]: hash });
  assert.equal(result.status, 'duplicate');
});

test('failed receipt stays uncommitted after another batch reuses its server sequence', function() {
  const operation = op({ type: 'ITEM_DELETE', baseVersion: 4 });
  const hash = context.opHash(operation);
  const existing = { operationHash: hash, status: 'applied', serverSeq: 8, entityVersion: 5 };
  // Another operation may later commit serverSeq 8. Exact canonical membership,
  // not the numeric sequence, determines whether this operation was committed.
  const committed = { 'different-op': context.opHash(op({ opId: 'different-op', type: 'ITEM_DELETE', baseVersion: 4 })) };
  assert.equal(context.resolveExistingOperation(operation, hash, existing, committed), null);
});

test('dependencies trust only current-batch success or exact canonical membership', function() {
  assert.equal(context.dependencySucceeded('parent', {}, { parent: 'hash' }), true);
  assert.equal(context.dependencySucceeded('parent', {}, { other: 'hash' }), false);
  assert.equal(context.dependencySucceeded('parent', { parent: { status: 'applied' } }, {}), true);
});
"""
test_text = replace_once(test_text, old_tests, new_tests, "receipt regression tests")
# Update the old call used by the conflict test.
test_text = replace_once(
    test_text,
    "  const result = context.resolveExistingOperation(operation, hash, existing, 99);",
    "  const result = context.resolveExistingOperation(operation, hash, existing, {});",
    "conflict test signature",
)
test_path.write_text(test_text, encoding="utf-8")

# Correct the deployment explanation so it describes exact commit membership.
doc_path = Path("SYNC_V3_MIGRATION.md")
doc = doc_path.read_text(encoding="utf-8")
doc = replace_once(
    doc,
    "An operation receipt may be written immediately before the active snapshot slot is switched. The server trusts an `applied` receipt only when its sequence is present in the committed snapshot. A newer receipt is treated as prepared but uncommitted, so the immutable operation is reapplied on retry. This protects stock deltas when a request fails during the final commit.",
    "An operation receipt may be written immediately before the active snapshot slot is switched. Numeric server sequences are not sufficient proof of commitment because a failed sequence can later be reused by another batch. The canonical snapshot therefore stores the exact immutable `opId → operation hash` set that it contains. A receipt absent from that set is prepared but uncommitted and is reapplied on retry; an operation present in the set is a duplicate even if its audit receipt is missing. This protects stock deltas across both sides of the final-commit failure window.",
    "receipt documentation",
)
doc_path.write_text(doc, encoding="utf-8")

print("Applied exact commit tracking, metadata write ordering, image limit, reminder lock, tests, and docs.")
