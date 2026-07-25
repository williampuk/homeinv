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
4. Deploy a new Web App version:
   - Execute as: **Me**
   - Who has access: choose the same access model used by the existing app
5. Copy the deployment URL into the application's Cloud Engine settings.

## 2. Storage created by v3

The backend creates:

- `Meta` — active snapshot slot, checksum, server sequence, and protocol metadata;
- `Data_A` and `Data_B` — double-buffered canonical snapshots;
- `Ops` — operation idempotency and audit records;
- `SyncAudit` — request-level diagnostics;
- `DeadLetters` — malformed or rejected operations;
- `Reminders` may continue to be used by reminder code.

Do not manually edit `Meta`, `Data_A`, `Data_B`, or `Ops` while clients are syncing.

## 3. Web deployment

The updated service worker caches `sync-v3-core.js` and `sync-v3.js` and injects them immediately after the existing `app.js` bundle. This keeps the large legacy UI intact while replacing its synchronization functions before `DOMContentLoaded`.

After deploying the web files:

1. Open the app while online.
2. Accept the service-worker update prompt and reload.
3. Confirm the sync indicator no longer reports a protocol mismatch.

A first visit may require one additional reload because the old service worker controls the initial page request.

## 4. Initial cloud bootstrap

When v3 sees an empty cloud, it does not automatically choose cloud-wins or local-wins.

- On a device containing inventory, confirm **Upload this device's inventory** to initialize the cloud.
- On an empty device, initialize an empty cloud only when that is intentional.
- Choosing Cancel keeps the device local-only and preserves its data.

## 5. Multi-device acceptance test

Use two browser profiles or devices.

1. Configure both with the same Apps Script URL and secret.
2. Confirm each profile has a different device ID.
3. Create an item on Device A and sync; confirm Device B receives it.
4. Take Device B offline, edit a different item, then reconnect; confirm both changes remain.
5. Edit the same item on both devices from the same starting version; confirm one operation is shown as a conflict rather than silently overwriting.
6. Adjust the same stock entry by `-2` and `+5`; confirm both deltas are counted once.
7. Retry after a simulated network timeout; confirm stock is not adjusted twice.
8. Delete an item on one device, then submit an old edit from another; confirm the stale edit cannot resurrect it.

## 6. Recovery

If migration must be rolled back:

1. Stop clients from syncing.
2. Preserve the v3 sheets for diagnostics.
3. Restore the legacy `Data` sheet from `Legacy_Data_Backup_*`.
4. Redeploy the previous Apps Script and web version together.

Do not mix a v3 server with a legacy client.
