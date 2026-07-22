# ADR 0002: Shared local application runtime

**Status:** accepted

Langtut implements learning policy in the browser-safe `domain` and `runtime` shared
packages. They own package parsing, placement and session rules, planning, progression,
content prompts and validation, sync projections, and the typed application contract.
Platform compositions may orchestrate persistence and external ports but may not
redefine those policies.

Fastify is the Windows HTTP adapter. Capacitor invokes the local runtime in process on
Android. Platform implementations are limited to orchestration around persistence,
files, OAuth and token acquisition, secret storage, provider transport and Anki
integration. They may not contain alternate learning rules.

The UI depends on a typed `LangtutClient`, never on route strings. Windows binds an HTTP
client; Android binds an in-process client. Both bindings must pass one conformance
suite. Android release artifacts must neither embed nor require a Langtut backend URL.

Local machine translation is an optional capability behind a shared port. Absence of a
platform implementation must be represented as unavailable and must not prevent the
core learning flow from using the configured cloud resolution path.
