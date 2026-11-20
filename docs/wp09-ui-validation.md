# Approval UI and browser evidence

The settings UI follows the host locale with German and English text. The
governance panel remounts on company/connection change and discards stale action
responses. Every operation response is checked against company, connection and
operation identity before rendering. Authorization errors clear previously
displayed policy, requests and sensitive previews.

Preview canonicalization independently recomputes the server snapshot SHA-256
before display or approval. The browser implementation is cross-checked against
the server canonicalizer in tests, with the same size/depth/node bounds. Full
message text and all To/Cc/Bcc recipients are rendered as escaped React text.
File bytes are decoded and represented by verified byte count and SHA-256 rather
than a multi-megabyte Base64 dump. Technical metadata remains available in native
expandable details; it is not silently omitted. Truncated or unknown operation
previews cannot be approved.

Approval and execution are separate actions. Only unexpired approved operations
offer execution; synchronous UI exclusion and the server reservation CAS guard
double activation. Unknown, failed and completed operations have no retry button.
The success text distinguishes service acceptance from confirmed mail delivery.

## Browser check performed 19 November 2026

`node scripts/preview-ui.mjs` serves the real panel and preview components from
`dist/ui-preview` on loopback port 3199 with an explicitly labelled synthetic SDK
action adapter. It makes no Microsoft or Paperclip requests. The fixture is a
regular repository test artifact, not a separate checkout or deployment.

Observed using the integrated browser:

- A pending synthetic mail request renders complete subject/text/To/Bcc and a
  verified three-byte attachment hash. Embedded script markup stays visible text.
- Enter activates approval without executing. A separate Enter activation
  executes once, displays `succeeded` plus the acceptance-versus-delivery wording,
  and removes the execution control.
- Unknown output displays a warning and no execution/retry control.
- An authorization error clears the prior operation/preview; company switch
  remounts to an empty initial state without retaining the previous company data.
- At a 390-pixel viewport, document scroll width was 390 pixels. Controls remain
  available in the narrow layout. The viewport override was reset afterwards.
- After adding full snapshot-hash verification and locale-specific labels, the
  page was rebuilt/reloaded and the correctly hashed fixture again produced an
  approvable, fully rendered preview.

This checks the actual React components with simulated actions, not the host's
embedded SDK UI transport or a production installation. Unit tests additionally
cover stale epochs, expiry, mismatched hashes/identities and binary limits. It is
not a complete screen-reader or accessibility conformance audit.

## Persisted app setup

The settings page loads and saves company-scoped configuration through the
host's existing authenticated `GET/POST /api/plugins/srahmel.m365/config`
contract. Saving requires host instance-administrator authorization. Tenant and
client IDs can be saved without a cache key. The optional read-only pilot
selection explicitly replaces scopes with `User.Read`, `Mail.Read`,
`Calendars.Read`, and `Files.Read`; otherwise existing scopes are preserved.
The cache field accepts only an existing secret reference ID, never a key value.
Saving does not start Microsoft sign-in or grant consent.

Before saving, the UI reads the latest configuration and merges edited settings,
preserving unknown fields and unedited secret references. The host endpoint has
no compare-and-swap contract, so simultaneous administrator writes between that
read and save cannot be made atomic by this UI. Avoid concurrent configuration
editing. Successful responses must confirm the saved configuration; HTTP errors,
malformed payloads, and cross-company responses are rejected.

Automated coverage verifies preservation, prerequisite gating, explicit pilot
selection, and failed saves. Live authenticated browser validation of this app
setup extension remains pending; earlier visual observations above describe the
previous UI and preview checks.
