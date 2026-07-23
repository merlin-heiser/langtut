# System architecture

## Ownership

| Data | Canonical owner | Local replicas |
|---|---|---|
| Cards, reviews, intervals, lapses | Anki / AnkiWeb | Anki Desktop, AnkiDroid |
| Langtut progress, sessions, settings, transcript references | Google Drive `appDataFolder` | SQLite on Windows, IndexedDB on Android |
| OAuth tokens and provider keys | current device only | none |
| Curriculum and package assets | signed/installed package, optionally Drive by content hash | installed package cache |

## Shared-first boundary

`packages/domain` owns domain rules, event schemas, reducers, provider request contracts and the Google Drive app-data protocol. A shared application runtime owns use-case orchestration. Fastify and Capacitor are adapters. They must not invent their own use case, event shape, merge rule, Drive filename or provider contract.

The shared runtime is browser-safe TypeScript and depends only on explicit ports for persistence, packages, credentials, provider transport, Google tokens, files, Anki, clocks and identifiers. Windows binds those ports to SQLite, the local filesystem, AnkiConnect and server-side provider clients. Android binds them to IndexedDB and native Capacitor plugins. React talks to a typed client interface: HTTP on Windows and an in-process client on Android.

## Synchronisation

Clients append immutable `SyncEventV1` events locally, upload closed segments to Drive, download unseen segments and reduce them idempotently. Progress is monotonic; milestones are set union; settings use last-write-wins by `(occurredAt, deviceId, sequence)`; transcript tombstones win. Raw dialogue content is stored in separate transcript blobs, not event segments.

## Platform symmetry

Every observable learning operation must pass the same runtime conformance suite through both the Fastify HTTP client and the Android in-process client. Android artifacts must not contain or require a Langtut backend URL. Optional capabilities such as local machine translation are reported explicitly and must not block the core learning flow.

In particular, the runtime schedules due Langtut chunk/rule cards, records an
automatic `Good` or `Again` only from evaluated session evidence, and projects that
evidence into target activation. Platform Anki bridges provide card discovery,
automatic grading and progress counts; they do not decide learning policy.
