# ADR 0002: Development delivery and deferred provider guarantees

Date: 2026-11-19. Status: development scope decision; not deployment approval.

Sebastian delegated development decisions and requested code validated as far as
practical. The delivery coordinator therefore chooses a bounded development
package instead of weakening safety requirements to complete unsupported cases.
The original product acceptance criteria in `docs/work-packages.md` remain
visible and are not retroactively declared satisfied.

## Decision

The current development delivery includes the implemented Mail, Calendar,
OneDrive read/create/rename/file-recycle, governance, UI, telemetry and recovery
foundations. Its acceptance requires successful exact-revision Linux/Windows
package and isolated integration gates and independent QA/security and operations
reviews with no unresolved material defect in that implemented scope.

OneDrive content replacement and folder deletion are excluded from this
development delivery. They remain explicit unsupported errors, not silent
fallbacks. Content replacement needs a separately designed and verified atomic
conditional provider operation; folder deletion needs a provider guarantee that
concurrent child creation cannot turn empty-only deletion into recursive deletion.
The evidence and API references are in `docs/wp08-drive.md`. A metadata preflight
alone is insufficient for either guarantee. This decision does not authorize an
upload-session implementation, recursive deletion or unconditional replacement.

The original WP08 remains partially fulfilled. Reviewers should report both the
development-scope result and the original-requirement gap. A green development
gate must never be described as full original CRUD acceptance.

## Separate release and pilot gates

Synthetic tests and isolated host/worker/database tests establish the boundaries
they actually exercise. They do not prove Microsoft tenant behavior, real message
delivery, invitations, production capacity, an LLM adapter run, or production
alarm delivery. The UI fixture does not establish full installed-host UI
acceptance. PostgreSQL archive recovery does not establish execution of the old
worker or a complete old-package/data/key rollback.

These remain release/pilot requirements in the original work packages. No real
Microsoft login, consent, production installation or production mutation is
authorized by this development decision. The packaged runbooks must preserve
those limits and artifact/source digest binding. Failed CI and genuine security,
integrity or operational defects cannot be waived by this scope decision.
