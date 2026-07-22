# Traceability

| Requirement | Contract / implementation | Verification |
|---|---|---|
| Learning progression | `specs/features/planner.md`, `packages/domain/src/progression.ts` | `tests/progression.test.ts` |
| Anki ownership | `specs/decisions/0001-shared-drive-sync.md`, `apps/api/src/anki.ts` | `tests/anki.test.ts` |
| Drive event sync | `specs/architecture/system.md`, `packages/domain/src/sync.ts`, `packages/domain/src/google-drive.ts` | `tests/sync.test.ts` |
| Shared local runtime | `specs/architecture/system.md`, `specs/decisions/0002-shared-local-runtime.md` | runtime/client conformance tests |
| Android bridge boundary | `specs/architecture/system.md`, `android/app/src/main/java` | standalone artifact assertion, Android debug build |
