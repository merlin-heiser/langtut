# System architecture

## Ownership

| Data | Canonical owner | Local replicas |
|---|---|---|
| Cards, reviews, intervals, lapses | Anki / AnkiWeb | Anki Desktop, AnkiDroid |
| Langtut progress, sessions, settings, transcript references | Google Drive `appDataFolder` | SQLite on Windows, IndexedDB on Android |
| OAuth tokens and provider keys | current device only | none |
| Curriculum and package assets | signed/installed package, optionally Drive by content hash | installed package cache |

## Shared-first boundary

`packages/domain` owns event schemas, reducers and the Google Drive app-data protocol. Fastify and Capacitor are adapters. They must not invent their own event shape, merge rule, Drive filename or provider contract.

## Synchronisation

Clients append immutable `SyncEventV1` events locally, upload closed segments to Drive, download unseen segments and reduce them idempotently. Progress is monotonic; milestones are set union; settings use last-write-wins by `(occurredAt, deviceId, sequence)`; transcript tombstones win. Raw dialogue content is stored in separate transcript blobs, not event segments.

## Current delivery state

Windows has the SQLite/Fastify runtime. Android has a Capacitor shell plus native OAuth and provider bridges. The fully local Android runtime (IndexedDB snapshot plus local implementations of learning routes) is not yet delivered; therefore Android currently still requires an explicitly configured API for the existing learning UI.
