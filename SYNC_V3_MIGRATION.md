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

   The secret must contain at least 16 characters. It is stored in Script Properties under `SYNC_SECRET_TOKEN`; it is no longer committed in source code.
3. If the spreadsheet already contains legacy data in the `Data` sheet, run:

   ```javascript
   migrateLegacyDataToV3()
   ```

   This creates a timestamped `Legacy_Data_Backup_*` sheet before initializing v3 storage.
4. To retain automatic daily reminder emails, run once:

   ```javascript
   setupTimeTrigger()
   ```

   This replaces any previous `checkAndRemind` trigger and creates a daily trigger around 7:00 AM in the Apps Script project's timezone.
5. Deploy a new Web App version:
   - Execute as: **Me**
   - Who has access: choose the same access model used by the existing app
6. Copy the deployment URL into the application's Cloud Engine settings.

## 2. Storage created by v3

The backend creates:

- `Meta` — active snapshot slot, checksum, server sequence, and protocol metadata;
- `Data_A` and `Data_B` — double-buffered canonical snapshots;
- `Ops` — operation idempotency receipts and audit records;
- `SyncAudit` — request-level diagnostics;
- `DeadLetters` — malformed or rejected operations;
- `Reminders` — server-owned reminder deduplication.

Do not manually edit `Meta`, `Data_A`, `Data_B`, or `Ops` while clients are syncing.

### Receipt recovery behavior

An operation receipt may be written just before the active snapshot slot is switched. The server trusts an `applied` receipt only when its sequence is included in the currently committed snapshot. A receipt newer than the committed sequence is treated as prepared-but-uncommitted and the immutable operation is reapplied on retry. This protects stock deltas when a request fails during the final snapshot commit.

## 3. Web deployment

The service worker caches `sync-v3-core.js` and `sync-v3.js` and returns them as part of one deterministic JavaScript response after `app.js`. This keeps the large legacy UI intact while installing protocol-v3 overrides synchronously before `DOMContentLoaded`.

After deploying the web files:

1. Open the app while online.
2. Accept the service-worker update prompt and reload.
3. Confirm the browser console contains:

   ```text
   [SyncV3] Protocol v3 browser integration loaded.
   ```
4. Confirm the sync indicator no longer reports a protocol mismatch.

A first visit or an upgrade from an older service worker may require one automatic or manual reload before the v3 integration controls the page.

## 4. Initial cloud bootstrap

When v3 sees an empty cloud, it does not automatically choose cloud-wins or local-wins.

- On a device containing inventory, confirm **Upload this device's inventory** to initialize the cloud.
- On an empty device, initialize an empty cloud only when that is intentional.
- Choosing Cancel keeps the device local-only and preserves its data.

After successful bootstrap, the represented local outbox is cleared because the complete projected device state is already in the canonical bootstrap snapshot. This prevents stock adjustments from being applied twice.

## 5. Conflict handling

When a conflict, rejection, or blocked dependency exists, click the sync-status pill.

- **Use cloud / discard local change** removes the failed local operation and rebuilds the local view from the canonical snapshot plus remaining operations.
- **Keep my version** is available for ordinary version conflicts and creates a new immutable operation based on the current server version.
- **Review details** displays the submitted payload, server entity, and version information.

A tombstoned entity cannot be restored through **Keep my version**. Create a new item explicitly instead.

## 6. Multi-device acceptance test

Use two browser profiles or devices.

1. Configure both with the same Apps Script URL and secret.
2. Confirm each profile has a different device ID.
3. Create a stock item with a new stock location on Device A and sync; confirm the parent item and entry both appear on Device B.
4. Take Device B offline, edit a different item, then reconnect; confirm both changes remain.
5. Edit the same item on both devices from the same starting version; confirm one operation is shown as a conflict rather than silently overwriting.
6. Open the conflict panel and test both **Use cloud** and **Keep my version**.
7. Adjust the same stock entry by `-2` and `+5`; confirm both deltas are counted once.
8. Retry after a simulated network timeout; confirm stock is not adjusted twice.
9. Delete an item on one device, then submit an old edit from another; confirm the stale edit cannot resurrect it.
10. Initialize an empty cloud while local stock changes are pending; confirm those quantities are not applied twice.

## 7. Automated validation

The pull-request workflow performs:

- JavaScript syntax checks for the browser modules, service worker, and Apps Script source;
- pure browser synchronization-core tests;
- Apps Script domain and idempotency tests in a Node VM with Apps Script primitives stubbed.

Run locally with:

```bash
node --check sync-v3-core.js
node --check sync-v3.js
node --check service-worker.js
cp GoogleSheetSync.gs /tmp/GoogleSheetSync.js
node --check /tmp/GoogleSheetSync.js
node tests/sync-v3-core.test.js
cp GoogleSheetSync.gs GoogleSheetSync.js
node tests/google-sheet-sync-v3.test.js
rm GoogleSheetSync.js
```

## 8. Recovery

If migration must be rolled back:

1. Stop clients from syncing.
2. Preserve the v3 sheets for diagnostics.
3. Restore the legacy `Data` sheet from `Legacy_Data_Backup_*`.
4. Redeploy the previous Apps Script and web version together.

Do not mix a v3 server with a legacy client.
