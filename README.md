# ORIGIN Hephaestus

A functioning feedback → isolated implementation → human review → approved publication application. Built from an empty workspace with React 19, Vite, TypeScript, Hono, Cloudflare Workers, D1 and Workflows. Uses the supplied ORIGIN flame logo.

**Deployment:** https://origin-hephaestus.cmpirmpos.workers.dev

**Repository:** https://github.com/CristosMpi/origin-hephaestus

The application is public: anyone can submit feedback and track their own requests without an account or login. A secure browser cookie preserves each visitor’s private request history. **Only administrators can review, approve and push code or change settings.** The application runs in live mode; sample generation, simulated publication and public role switching have been removed. Historical sample records are excluded from live views and metrics.

Feedback is saved even before repository/model connections are configured. Requests remain Submitted with a clear setup event, then the background scheduler starts them after an administrator connects the repository and isolated runner. No fake code or successful push is produced.

## Run locally

Requires Node.js 22+ and npm. From this directory:

```sh
npm ci
npm run types
npm run db:local
npm run build
npm run dev:api
```

Open http://127.0.0.1:8787. For frontend hot reload, run `npm run dev` in a second terminal and open the Vite URL. Vite proxies `/api` to port 8787. Local D1 and Workflows state live in the ignored `.wrangler/` directory.

```sh
npm run check
npm --prefix runner test
```

`check` runs lint, TypeScript, backend tests in the actual Workers runtime, and the production frontend build. Worker tests use local D1, not the deployed database. The runner security tests do not require Docker. Docker and real provider/GitHub credentials are needed for a live coding end-to-end test.

## Architecture

```text
React interface / ORIGIN backend proxy
       │ authenticated requests
       ▼
Cloudflare Worker (API, verified human identity, approval, publisher)
       ├── D1: requests, proposals, sessions, permissions, append-only audit events
       ├── Workflows: durable coding job, retries, timeouts, revision identity
       └── authenticated HTTPS → trusted runner broker
                                  ├── read-only repository clone
                                  ├── configurable model API (server credentials)
                                  └── Docker check container
                                      no network, no secrets, no Docker socket

Human approval binds commit SHA + repository/base/dedicated branch
       ▼
Publisher: exact Git tree/commit → dedicated branch → pull request
```

Workers Static Assets serves the responsive frontend and reusable component. D1 is the source of truth. Workflows performs analysis, implementation, validation and review preparation. A five-minute Cron Trigger marks abandoned jobs failed after 15 minutes and removes expired sessions/rate buckets. The configured job timeout is at most ten minutes; individual container checks are bounded to two minutes and a job has bounded model attempts. Workflow retries use a stable request/revision job ID; the runner caches successful results to disk and rejects reuse with changed inputs.

## Screens and workflow

- **Overview:** active pipeline, measured outcomes, workbench and recent activity.
- **Requests:** search by title/ID/application and filter by type/status.
- **Details:** original feedback, page/version context, timestamped journey, executed checks and logs, comments and immutable proposal history.
- **Review:** original request, implementation plan/summary, changed files, unified diff and patch download, check outputs, limitations, historical revisions and human decisions.
- **Settings:** repository/base, application list, coding model, trusted checks, execution/revision bounds, reviewer roles and integration readiness. Settings changes do not silently redirect an existing proposal.
- **Insights:** all eight metrics, definitions, sample sizes and empty measurement states.

All requested statuses are supported. Validation failures remain visible in review and block approval. A reviewer can request a bounded revision with comments, reject a proposal, or approve and publish. A failed coding job can be retried within the configured revision limit. A failed publish keeps the recorded approval and offers a separate retry.

## Connect coding and publishing

1. **Choose the GitHub repository and base branch** in Settings. This application's source repository is `CristosMpi/origin-hephaestus`, with `main` as its base branch. Repository content is treated as data, not authority to access other systems.
2. **Open administrator controls** at https://origin-hephaestus.cmpirmpos.workers.dev/#/admin using the workspace access key stored privately in `.local/admin-access-key.txt`. The key is configured as the `ADMIN_ACCESS_KEY` Worker secret; it is never bundled into the frontend or printed in chat. To provision or restore the configured local key, run `npm run admin:configure`. Admin access lasts eight hours, the Log out action revokes the server session and returns to the public feedback page, and rotating the key invalidates existing admin sessions. Public visitors do not need this key. Cloudflare Access is optional for existing administrator identities; do not place a login gate in front of the public feedback interface.
3. **Run the trusted broker** on a dedicated Linux host with Docker. It must not share a host with production workloads or secrets. Copy `runner/.env.example` to `runner/.env` (ignored), configure `RUNNER_TOKEN`, `MODEL_API_KEY`, `MODEL_BASE_URL`, optional **read-only** `GITHUB_READ_TOKEN`, and the explicit `ALLOWED_REPOSITORIES` list. Build the check image and start the broker:

   ```sh
   docker build -t hephaestus-checks:1 -f runner/Dockerfile.checks runner
   cd runner
   npm start
   ```

   It binds to `127.0.0.1:9090`. Expose it through authenticated HTTPS (for example a Cloudflare Tunnel) and require the broker's bearer token. Use a persistent `JOB_CACHE_DIR` owned only by the broker. Do not expose a Docker socket or model key to the code containers. The broker handles two concurrent jobs, at most 5,000 repository files, 21 inspected files, 40 changed files and a 300 KB diff. It rejects uninspected existing file edits, symlinks, metadata/secrets paths and binary changes.

   **Dependencies:** the default check container is networkless and has Node/npm/git, but no application dependencies. Supply a trusted image with the target repository's dependencies already installed or a trusted prepopulated dependency cache. Configure commands such as `NODE_PATH=/opt/dependencies/node_modules /opt/dependencies/node_modules/.bin/vitest run`. Do not add model or GitHub credentials to an image. Until dependency provisioning is configured, dependency-dependent tests/builds will fail honestly and approval remains blocked. Other stacks require an appropriate check image and commands.

4. **Configure Worker secrets** with the interactive CLI; never put credentials in source, command arguments, Settings, a repository checkout or chat:

   ```sh
   npx wrangler secret put ADMIN_ACCESS_KEY
   npx wrangler secret put FEEDBACK_API_TOKEN
   npx wrangler secret put RUNNER_URL
   npx wrangler secret put RUNNER_TOKEN
   npx wrangler secret put GITHUB_WRITE_TOKEN
   ```

   Use a dedicated repository-scoped GitHub fine-grained token with Contents and Pull requests write permissions. This publishing token exists **only on the Worker**, never on the runner or its containers. For production, rotate tokens or replace with an installation-token broker for a GitHub App. The model API key exists only in the trusted runner process; choose any compatible endpoint on that server. No provider credentials reach the frontend.

5. The app is already configured with `APP_MODE=live`. Once repository/runner secrets are ready, saved requests are queued after Settings changes or within the next scheduler run. Publishing additionally requires `GITHUB_WRITE_TOKEN` and approval by an administrator. Verify against a test repository before production use.

```sh
npm run types
npm run check
npm run db:remote
npm run deploy
```

The included deployment uses Worker `origin-hephaestus`, D1 `hephaestus`, and Workflow `hephaestus-coding` in the connected account. To deploy to a different account, create a fresh D1 database, update the IDs/account configuration and apply migrations there first. D1 migrations and deployment are explicit scripts; no merge or deployment is triggered by a submitted feedback request.

## Approval and publication invariants

- Only an authenticated administrator session or verified administrator identity can approve and push. Public contributors cannot promote their role. Submission tokens are scoped to `POST /api/requests`; they cannot read settings/requests, review, impersonate a person or publish. No model interface can call the review endpoints.
- The review action includes the full commit SHA, exact `owner/repo@base:branch` destination and optimistic version. Backend checks and an atomic conditional write reject stale review actions. Failed required checks prevent approval.
- Database triggers invalidate approval when proposal JSON or destination changes, even outside the API. Approved publications lock these fields while pushing and after completion. Proposal changes require a fresh human approval.
- A separate publisher rechecks approval before obtaining the push claim. It reconstructs the Git tree and commit through GitHub's Git Data API and compares both resulting SHA values to the reviewed proposal **before creating a branch**. It never moves an existing branch with a different SHA.
- Push retries reuse the dedicated branch only if it already has the approved commit. Existing pull requests are discovered by exact head/base, including closed ones, before creating another. Completed publication returns the stored outcome without another write. The publisher never merges or deploys.
- D1 records the approver, timestamp, destination, commit, publication event and PR URL. Audit events cannot be updated/deleted through SQL triggers. Proposal snapshots are kept per revision.
- The supplied broker runs repository test commands only in disposable, non-root, networkless Docker containers with dropped capabilities, a read-only root filesystem, resource limits and a read-only `.git` bind. Repository code cannot inherit host/model/publisher credentials.
- Sandbox isolation is a Docker boundary, not a guarantee against kernel exploits. For adversarial multi-tenant workloads, run the broker on a dedicated disposable VM or replace the executor with a hardened service such as Cloudflare Sandbox. No Sandbox deployment is claimed here.

## Feedback integration

From an authenticated ORIGIN server, send JSON to `POST /api/requests` with `Authorization: Bearer <FEEDBACK_API_TOKEN>`. The body contains `type` (`bug`, `feature`, `improvement`), `title`, `description`, `expected`, `application`, and optional `pageUrl`/`version`. Bugs require `steps` and `actual`. The application must be in Settings' application list. The API returns the persisted request ID and initial state. Bodies are capped at 128 KB and submission is rate-limited to 20 requests per ten minutes per identity.

For an embedded form, host `/feedback.js` in your ORIGIN app or load it from Hephaestus:

```html
<script src="https://origin-hephaestus.cmpirmpos.workers.dev/feedback.js" defer></script>
<origin-feedback
  endpoint="/api/origin-feedback"
  application="ORIGIN CRM"
  version="2.4.1"
></origin-feedback>
```

Your same-origin `/api/origin-feedback` backend applies its own CSRF/abuse checks, then forwards to Hephaestus with its server-side submission token. The component captures `location.href`, supplied version and user-entered context, displays validation errors and emits `feedback-submitted` with `detail.id`. It never embeds a service token in browser code. For Access-protected service submission, use an Access service token in the ORIGIN backend as well. Browser cross-origin mutations are rejected; cross-origin tokens are not enabled with permissive CORS.

## Metric definitions

Values use the latest 500 requests visible to the visitor or administrator, in the current mode. Every metric shows its sample size; no sample means no estimated value. Timestamps are UTC ISO 8601 in D1 and displayed in Europe/Athens time. Durations are nonnegative and use medians.

| Metric                    | Definition / denominator                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time to review-ready code | Submission → first review-ready code, including queue/analysis/coding/validation. Stops before approval waiting. Samples: requests with a first ready time.                      |
| Developer review time     | First review opening → approval, including discussion and revisions. A wall-clock review-window measure, not active editor time. Samples: approved requests with a review start. |
| First-review acceptance   | First decision approves without requesting a revision ÷ requests with a first review decision. Rejection/revision counts as 0.                                                   |
| First-pass validation     | All configured checks pass on the first implementation ÷ requests with a first validation outcome.                                                                               |
| Requests completed        | Requests whose approved dedicated branch and PR publication completed. Historical sample records are excluded.                                                                   |
| Approval waiting time     | First ready → approval/rejection, or now if still pending. Includes discussion and revision cycles; does not increase the initial development metric.                            |
| Approval to push          | Approval → successful publication. Samples: completed publications.                                                                                                              |
| Pushes with approval      | Completed publications with exact commit/destination approval ÷ completed publications.                                                                                          |

## Verification and remaining integration limits

- Backend tests execute in `workerd` with D1: authentication, input validation, contributor/reviewer permissions, stale SHA/destination/version, unapproved publication, failed checks, exact recorded approval, idempotent completion, proposal/destination invalidation, publication locking, own-request visibility, append-only audit, CSRF, disabled legacy role switching and metric timing.
- The browser workflow covers form submission → durable job → validation → review, revisions and approval; the deployed service is smoke-tested separately. Check `docs/verification.md` for the final results.
- The runner has source-path/allowlist/bounded execution tests. Docker is not installed in the build environment; a real model-driven Docker job and real GitHub publication have **not** been executed. Live credentials, a target repository, administrator access and a dependency-ready runner image remain operator setup.
- Provider compatibility is for the Chat Completions JSON-object interface; providers without that interface need an adapter. Repository inspection is bounded and may require splitting very large changes. Only UTF-8 regular file edits/additions/deletions are supported; symlinks, binary files, Git LFS and submodule modifications require a separate executor implementation.
- Broker cache survives process restarts when on a persistent disk; an interrupted in-flight job is safely re-run. A broker crash after creating a GitHub branch is recovered by the publisher's head/PR checks. If a Worker crashes while holding a publish claim, the claim is intentionally left locked: an operator must reconcile GitHub's exact head/PR and clear the claim only if safe. No automatic unsafe unlock is performed.

Cloudflare references: [Static Assets](https://developers.cloudflare.com/workers/static-assets/binding/), [D1](https://developers.cloudflare.com/d1/get-started/), [Workflows](https://developers.cloudflare.com/workflows/get-started/guide/), [Workers testing](https://developers.cloudflare.com/workers/testing/vitest-integration/).

## Public access verification

`npm run smoke -- https://origin-hephaestus.cmpirmpos.workers.dev` verifies anonymous access and denied public publishing. Add `--admin-key-file .local/admin-access-key.txt` to verify the protected administrator session without exposing the key. See `docs/verification.md` for the current verification record. Unit tests retain isolated synthetic fixtures under `tests/fixtures`; these are not imported by the deployed Worker.

## Public contributor interface

Public contributors see one page with the ORIGIN logo, the Small feedback / Meaningful progress banner and the feedback form embedded directly below. There is no public sidebar, request list, activity feed, insights, settings, guide, setup notice or dashboard metrics. Submitting feedback stays on the page and shows a reference ID. Existing public hashes render this same simple page; administrator access remains at /#/admin, with the protected workspace available after admin authentication. Public pages do not poll request/activity/metrics endpoints.

Administrator logout is available in the workspace header on every admin screen and in the administrator access card. It deletes the stored admin session, clears the admin cookie, and reloads the public feedback page.
