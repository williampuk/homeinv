# Sync v3 deployment and migration

This branch replaces the legacy mixed snapshot/operation sync protocol with protocol version 3.

## Important compatibility rule

The v3 Apps Script backend intentionally rejects old clients with `PROTOCOL_VERSION_MISMATCH`. Deploy the web files and Apps Script update together.

## 1. Update the Apps Script project

1. Replace the existing Apps Script source with `GoogleSheetSync.gs` from this repository.
2. In the Apps Script editor, run:

   ```javascript
   setSyncSecret('replace-with-a-long-random-secret')
   ```

   The secret must contain at least 16 characters and is stored in Script Properties as `SYNC_SECRET_TOKEN`.
3. For an existing legacy `Data` sheet, run once:

   ```javascript
   migrateLegacyDataToV3()
   ```

   This creates a timestamped `Legacy_Data_Backup_*` sheet before initializing v3 storage.
4. To retain automatic daily reminder emails, run once:

   ```javascript
   setupTimeTrigger()
   ```

5. Deploy a new Web App version using the same access model as the existing deployment.
6. Copy the deployment URL into the application's Cloud Engine settings.

## 2. Server storage

The backend creates:

- `Meta` — active snapshot slot, checksum, server sequence, and protocol metadata;
- `Data_A` and `Data_B` — double-buffered canonical snapshots;
- `Ops` — operation idempotency receipts and audit records;
- `SyncAudit` — request-level diagnostics;
- `DeadLetters` — malformed or rejected operations;
- `Reminders` — server-owned reminder deduplication.

Do not manually edit `Meta`, `Data_A`, `Data_B`, or `Ops` while clients are synchronizing.

### Receipt recovery

An operation receipt may be written immediately before the active snapshot slot is switched. Numeric server sequences are not sufficient proof of commitment because a failed sequence can later be reused by another batch. The canonical snapshot therefore stores the exact immutable `opId → operation hash` set that it contains. A receipt absent from that set is prepared but uncommitted and is reapplied on retry; an operation present in the set is a duplicate even if its audit receipt is missing. This protects stock deltas across both sides of the final-commit failure window.

## 3. Web deployment and first load

The service worker returns one deterministic JavaScript bundle containing `app.js`, `sync-v3-core.js`, and `sync-v3.js`. This installs the v3 overrides synchronously before `DOMContentLoaded` on controlled pages.

After deploying:

1. Open the app while online.
2. Allow the service-worker controller change to reload the page, or accept the update prompt.
3. Confirm the browser console contains:

   ```text
   [SyncV3] Protocol v3 browser integration loaded.
   ```

4. Do not make inventory changes until that message appears.

A first visit or an upgrade from an older service worker may require one automatic or manual reload.

## 4. Local durability and offline operation capture

The browser stores separately in IndexedDB:

- projected application state;
- the immutable operation outbox;
- canonical snapshots scoped by Apps Script deployment URL;
- a stable local baseline used before the first trusted cloud pull.

Projected state and newly generated operations are committed in one IndexedDB transaction. A tab or browser crash must not leave a locally saved edit without the operation required to synchronize it.

Repeated offline changes are calculated from the stable baseline plus the existing outbox. This covers rapid item edits, stock-entry creation followed by item edits, structural document changes, and stock adjustments that increment both entry and parent-item versions.

Long-offline outboxes are sent in ordered batches of at most 100 operations, matching the Apps Script request limit.

## 5. Initial bootstrap and an initialized cloud without a baseline

When the cloud is empty, the app never automatically selects cloud-wins or local-wins:

- confirm **Upload this device's inventory** to initialize from a populated device;
- initialize an empty cloud only when intentional;
- choosing Cancel keeps all data local.

After bootstrap, the represented local outbox is cleared because the complete projected device state is already in the canonical snapshot. This prevents stock adjustments from being applied twice.

When an initialized cloud is connected to a device that has local data but no trusted baseline for that exact deployment URL, the app asks before replacing the device copy. Accepting replacement clears that endpoint's untrusted outbox before loading the cloud. Canceling preserves the local copy unchanged.

## 6. Changing the Apps Script deployment URL

Canonical snapshots and operations are scoped to the exact deployment URL.

- Operations for the old URL are never uploaded to a new URL.
- They remain visible in the synchronization-problem panel.
- Switching back to the original URL makes those operations eligible again.
- They may also be discarded explicitly.

Changing the URL is not a data-migration mechanism. Export, bootstrap, or reconcile intentionally.

## 7. Conflict handling

Click the sync-status pill when a conflict, rejection, blocked dependency, or operation for another endpoint exists.

- **Use cloud / discard local tree** removes the selected operation and every dependent descendant, then rebuilds the projected state.
- **Keep my latest version** captures the complete latest projected result, removes the obsolete dependency tree, and creates a new immutable operation chain against current canonical versions.
- **Review details** displays the operation payload, dependency, endpoint, server entity, and version data.

A tombstoned entity cannot be restored through **Keep my latest version**. Create a new entity explicitly.

## 8. Multi-device acceptance test

Use two browser profiles or devices.

1. Configure both with the same Apps Script URL and secret and confirm different device IDs.
2. Create a stock item with a new location on Device A; confirm both parent and entry reach Device B.
3. Before a first cloud pull, create an item and edit it twice rapidly; reload offline and confirm the ordered operations remain.
4. Perform more than 100 offline changes and reconnect; confirm all ordered batches synchronize.
5. Edit different items on each device and confirm both changes remain.
6. Edit the same item from the same starting version and confirm an explicit conflict.
7. Add a dependent local change after that conflict; resolve the root and confirm the complete tree is discarded or regenerated consistently.
8. Apply `-2` and `+5` to the same stock entry and confirm the final delta is `+3`, exactly once.
9. Retry after a simulated timeout and confirm no duplicate stock adjustment.
10. Delete an item on one device and submit a stale edit from the other; confirm no resurrection.
11. Bootstrap an empty cloud with pending stock changes and confirm quantities are not doubled.
12. Temporarily change the Apps Script URL and confirm old-endpoint operations are not uploaded to the new endpoint.

## 9. Automated validation

The pull-request workflow performs:

- syntax checks for browser modules, the service worker, and Apps Script source;
- pure synchronization-core tests;
- a browser integration test with an in-memory IndexedDB model;
- Apps Script domain and idempotency tests in a Node VM.

Run locally with:

```bash
node --check sync-v3-core.js
node --check sync-v3.js
node --check service-worker.js
cp GoogleSheetSync.gs /tmp/GoogleSheetSync.js
node --check /tmp/GoogleSheetSync.js
node tests/sync-v3-core.test.js
node tests/sync-v3-browser-integration.test.js
cp GoogleSheetSync.gs GoogleSheetSync.js
node tests/google-sheet-sync-v3.test.js
rm GoogleSheetSync.js
```

## 10. Recovery

1. Stop clients from synchronizing.
2. Preserve the v3 sheets for diagnostics.
3. Restore the legacy `Data` sheet from `Legacy_Data_Backup_*`.
4. Redeploy the previous Apps Script and web version together.

Do not mix a v3 server with a legacy client.
