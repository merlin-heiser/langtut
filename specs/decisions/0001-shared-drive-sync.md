# ADR 0001: Shared Google-Drive sync, Anki-owned SRS

**Status:** accepted

Langtut stores shared application state as immutable event segments in Google Drive `appDataFolder`. Clients resolve events locally. There is no Langtut client-to-client protocol and no Langtut sync server.

Anki owns notes and all spaced-repetition state; Langtut only materializes items through platform-specific bridges. Review history is never copied into Drive.

The Drive REST protocol, event types and merge rules are platform-neutral shared code. OAuth is a platform adapter: Windows uses browser PKCE; Android uses the system account picker. Local stores are caches/outboxes, never a competing source of truth.
