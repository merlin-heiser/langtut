# Specifications

`product.md` contains stable product rules. `architecture/` specifies component boundaries and data ownership. `decisions/` is the immutable record of consequential choices. `features/`, `api/` and `schemas/` specify user-visible behaviour and machine contracts. `acceptance/` defines release gates.

Change order: decision/spec → contract/schema → implementation → test → acceptance. If a change affects more than one client, the shared contract must be changed before either client implementation.
