# ManeBid 3.1 Release Notes

These notes summarise the current `feature/qrcode` branch state compared with the local `main` branch.

## Features

- Added auction QR code generation from the Manage Auctions screen, including configurable public URL root, colours, output size, and optional centre image.
- Improved the public item submission flow, including clearer handling when an auction is not currently accepting submissions.
- Added operator-to-operator messaging across management screens, with unread counts, presence indicators, broadcast messages, attention messages, acknowledgements, optional browser notifications, and item references.
- Added a more complete managed backup and restore workflow, including server-side backup archives, backup download, backup inspection, import preview, selective restore, restore logging, and restore permission controls.
- Added richer Maintenance tooling, including storage reporting, integrity checks, log viewing/export, generated test-data controls, and better backup/import diagnostics.
- Added CSV item import from Manage Items with preview, validation, per-row selection, optional images, and normal item creation/photo processing.
- Improved SumUp payment handling with pending payment tracking, hosted checkout recovery links, cashier-side verification, cancellation, retry/polling support, and a dedicated payment result page.
- Added a buyer-facing cashier display and improved cashier settlement views, including pending-payment visibility and clearer payment/donation handling.
- Reworked slideshow operation into a kiosk-style shared session flow with improved controls and auto-refresh behaviour.
- Added light/dark theme bootstrapping and broader user preference persistence across operator pages.
- Updated branding from the older auction naming to ManeBid across service/config names, documentation, and UI copy.
- Rebuilt and expanded user documentation with updated screenshots, quick-start guidance, SumUp/payment design notes, and refreshed installation material.
- Added third-party notices for vendored frontend dependencies.

## Security

- Moved browser authentication away from bearer-token persistence toward HttpOnly session cookies with CSRF tokens held in memory.
- Added CSRF enforcement for authenticated browser requests and updated frontend calls to use authenticated fetch helpers.
- Added stricter session scoping for slideshow/kiosk mode and continued support for remote logout/session invalidation.
- Added Helmet baseline headers, disabled `X-Powered-By`, tightened CORS configuration, and added explicit trusted proxy configuration.
- Added Content Security Policy metadata to public HTML pages and moved inline scripts/handlers into external scripts.
- Added Apache security header guidance, including CSP, frame blocking, content-type sniffing protection, referrer policy, permissions policy, and upload request limits.
- Strengthened login and public submission rate limiting using `rate-limiter-flexible`, including separate username/IP lockout behaviour.
- Tightened request body and upload limits for JSON, form posts, item photos, resource images, and backup imports.
- Hardened image upload validation by checking file extension, MIME type, and actual image content.
- Reworked managed backup import handling to stream and validate ZIP files, reject unsafe paths and unsupported entry types, enforce entry/count/expanded-size limits, and stage imports before confirmation.
- Added a dedicated `restore_database` permission for sensitive backup download/import/restore operations.
- Redacted sensitive tokens, payment identifiers, and callback parameters from logs, and made log rendering safer in the browser.
- Hardened SumUp app payment finalisation so callbacks are not trusted by themselves; transactions are checked against merchant, amount, currency, foreign reference and/or transaction code.
- Updated dependencies and removed older body parsing patterns in favour of Express limits and current middleware.
- Added a dedicated security test suite covering CSP compatibility, CSRF/session behaviour, SumUp verification, upload controls, backup ZIP validation, and browser rendering safety.

## Bugfixes

- Fixed SumUp payment intent verification and finalisation paths, especially around delayed app callbacks, hosted checkout recovery, duplicate notifications, and pending payment retries.
- Prevented multiple active pending SumUp intents for the same bidder and exposed existing pending intents clearly to the cashier.
- Improved handling of failed, pending, unavailable, unknown, and mismatched SumUp verification states.
- Fixed QR code generation error handling so image-processing failures are reported cleanly.
- Improved cashier polling to avoid overlapping renders and unnecessary UI refresh churn.
- Fixed payment/donation validation so donations are handled separately from item balance payments and zero-balance donation flows work more clearly.
- Improved refund/payment display and settlement export calls to use the hardened authenticated request path.
- Improved user management permission editing so operators cannot grant roles or permissions they do not hold, while preserving existing access correctly during edits.
- Added a safer reset flow that can clear auction/item data without removing users.
- Added cleanup for generated test users and broadened test-data/bid generation controls to support setup and locked auction states.
- Improved resource upload cleanup so rejected temporary files are removed reliably.
- Improved backup import validation and restore diagnostics for incompatible schemas, invalid archives, missing metadata, and partial/malformed backups.
- Updated generated docs and screenshot references so the user guide matches the new UI structure.
