# Public access and administrator approval verification

Verified on 28 October 2026 against https://origin-hephaestus.cmpirmpos.workers.dev. The active deployment runs in live mode.

## Behavior

- Anyone can open the workspace, submit feedback and track their own requests without an account or login. A secure anonymous browser cookie preserves request ownership.
- Only administrators can change settings, review, approve and push changes. Public users, API submission credentials, reviewer labels and forged role headers cannot gain administrator permissions.
- Settings contains a protected administrator access panel. The key is stored in the Worker secret ADMIN_ACCESS_KEY and in the owner's ignored local file .local/admin-access-key.txt, never in frontend code or this report.
- Admin sessions expire after eight hours. Logout revokes the stored session; key rotation invalidates previously opened admin sessions. Historical demo cookies and role-switch endpoints no longer grant access.
- Runtime sample generation and simulated publication were removed. Historical sample records remain archived and are excluded from live screens and metrics.
- Requests are persisted with status Submitted when repository/runner connections are absent. The UI explicitly says they are saved and waiting for workspace setup; no fake implementation or successful push is produced. Queued requests resume after the real integrations are configured.

## Checks

| Check                                     | Result                                                       |
| ----------------------------------------- | ------------------------------------------------------------ |
| Worker/D1 tests                           | 29 passed in workerd                                         |
| ESLint / React / accessibility rules      | Passed                                                       |
| TypeScript against generated Worker types | Passed                                                       |
| Production Vite build                     | Passed                                                       |
| D1 public-access migration                | Applied locally and remotely                                 |
| Deployed anonymous API access             | Passed without credentials                                   |
| Public approval / push / settings writes  | Rejected with HTTP 403                                       |
| Legacy role switching                     | HTTP 404                                                     |
| Administrator access key                  | Valid key opens admin session; wrong key rejected            |
| Administrator logout                      | Session revoked; publishing denied again                     |
| Private visitor ownership                 | Other visitors cannot read the request                       |
| Admin secrets                             | Ignored local files; server-side Worker binding; not printed |

The deployed API smoke test saved request HEP-C14E8417 without an account, confirmed the setup status, opened administrator access using the private key and revoked it again. No repository was modified.

The in-app browser submitted request HEP-A3415F44 through the actual public form and followed its saved status without logging in. The updated detail screen displays Saved — waiting for workspace setup. The browser also opened administrator controls with the private key, verified that Save changes became enabled, closed admin access, and verified that Save changes became disabled again.

## Remaining integrations

A real ORIGIN repository, model credentials, isolated runner and GitHub publishing credential are still unconfigured. Real AI implementation and repository publication cannot run until those are connected. The app accepts and stores real feedback now. The GitHub publisher remains protected by the exact reviewed commit/destination approval gate; its adapter behavior is covered with mocked GitHub responses, not a real remote push.

## Simplified public interface

Public contributors now see only the logo, the Small feedback / Meaningful progress banner and an embedded feedback form. Sidebar navigation, setup notice, request/activity/insight/settings/guide pages and dashboard data are absent. Public legacy routes show this same single page. Administration is isolated at /#/admin.

All 29 Worker tests, ESLint, TypeScript and the production build passed. Chromium checks at 1440×1000 and 390×844 verified the embedded form submits and resets in place, shows a saved reference, causes no JavaScript errors, and fits without horizontal overflow. The protected admin workspace and enabled administrator controls were verified separately. The in-app browser connection returned an availability error, so the installed Chromium browser was used through Playwright for this verification.

## Administrator logout

The admin header now has a visible Log out button on every workspace screen, including mobile. The administrator access card uses the same action. Logging out deletes the server session and admin cookie, returns to /#/dashboard and reloads the application to clear cached admin UI. Lint, type checking, the production build and all seven public/admin boundary tests passed. Browser verification replays the revoked cookie to confirm it cannot publish.
