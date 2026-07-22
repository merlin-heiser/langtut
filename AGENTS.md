# Langtut: spec-driven development

## Source of truth

1. `specs/product.md` defines product invariants.
2. `specs/architecture/` defines boundaries and data flows.
3. `specs/decisions/` contains immutable architecture decisions (ADRs).
4. Feature specs, schemas and OpenAPI define observable behaviour and contracts.

Before changing behaviour, update or add the relevant spec/ADR. Implementation and tests must reference the same requirement in their PR/commit description.

## Architecture guardrails

- Put domain rules, sync events, Drive file protocol and provider request contracts in `packages/domain` (or a new shared package), never in Android or Fastify only.
- Platform code is limited to UI, local storage, OAuth/token acquisition, Anki bridges and native transport.
- Anki is the sole truth for cards and SRS. Google Drive is the sole shared truth for Langtut state. SQLite/IndexedDB are rebuildable local snapshots and outboxes.
- Credentials, OAuth tokens and provider keys are local-only. Never add them to sync events, Drive payloads, logs or `VITE_*` variables.
- Do not declare Android autonomous until the Android runtime has local implementations for the currently Fastify-owned learning routes.

## Required verification

- Run `npm run spec:lint`, `npm run typecheck` and focused tests for changed contracts.
- For Android-native changes run `cd android; ./gradlew.bat assembleDebug`.
- If an implementation contradicts a spec, stop and update the spec/ADR before extending it.
