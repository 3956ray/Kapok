# vinext-starter

A clean full-stack starter running on [vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git is required only for publishing

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Run `node <plugin-root>/scripts/configure-execution-profile.mjs` only when the profile is unknown for the current checkout and environment. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

For browser QA on managed Linux, use `sites-preview start`. The project's dev script runs Vite and accepts the supervisor's `--host 0.0.0.0 --port 4173 --strictPort` arguments. The internal browser uses `http://terminal.local:4173/`; it is not a user-facing URL. The supervisor owns the preview lifecycle. The ignored local profile survives the supervisor's cleared process environment.

The portable profile simulates ChatGPT sign-in only for loopback development requests. Visit `/signin-with-chatgpt?return_to=/` to sign in as `local_seedy` (`seedy@sites.test`, display name `Seedy`) and `/signout-with-chatgpt?return_to=/` to sign out. The development cookie preserves that identity across server restarts. Mock auth is disabled in the managed-linux profile and is not included in production builds; hosted authentication remains dispatch-owned.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Use it as the durable user key; use email and name for display or contact purposes.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use the returned `userId` as the stable user key for user-owned records; do not use email as a durable identifier.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_example.sql
```

Replace the filename with the pending migration and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)

## Kapok CP03 T1 application

This checkout contains the owner-private **synthetic** Kapok review app. T1 implements the platform identity mapping, controlled one-time team bootstrap, one-use synthetic invitations, join/profile persistence and the four mobile navigation destinations. Training, media, growth/reflections, member directory and personal data lifecycle remain explicitly pending for the next packages. There is no global role switch, email OTP, real member onboarding or production-readiness claim.

### Schema and verification

The schema-only migration is `drizzle/0000_identity.sql`; `db/schema.ts` and `drizzle/meta/0000_snapshot.json` describe the same ten base tables. Apply source migrations in order using the official lifecycle above. Requests never create tables. Later schema changes must be new migrations, not edits to an applied migration.

- `npm run test:integration` runs Node 24 native tests against real isolated Miniflare D1 databases, including restart persistence, invitation concurrency, whole-batch rollback and a real commit followed by a synthetic lost transport response.
- `npm run typecheck` checks application TypeScript without emitting files.
- `npm run lint` runs the starter's ESLint checks.

The dependency set is unchanged. Tests use the Miniflare already supplied by the official starter installation. The installed workerd supports compatibility date `2026-05-22`, which the local test/fixture harness pins deliberately.

### Explicit local fixture

Stop the local preview before seeding its database, then run:

```sh
node scripts/seed-local.mjs --confirm-local
```

This writes **only local disk state** under `.wrangler/state/v3/d1`, using the placeholder local D1 ID from `vite.config.ts`. It applies the T1 schema only if absent, then invokes the same guarded bootstrap service with the official loopback identity `local_seedy`. The one-use synthetic invitation is printed only on the first successful initialization. Repeating the seed does not reset membership, consume invitations or change the administrator. For an isolated throwaway fixture use `--state-dir <local-directory>`.

Start the portable preview with the official lifecycle, then visit the normal top-level `/signin-with-chatgpt?return_to=/` link to use the starter's loopback-only synthetic login. The app labels local synthetic mode. This seed is never a hosted bootstrap path; do not upload its local state.

### Hosted owner initialization

Only the controller configures and publishes the Site. After schema migration and owner-private audience verification, the signed-in owner can inspect `GET /api/v1/bootstrap` for their own stable Site user ID. Configure `BOOTSTRAP_SITE_USER_ID` as that exact identity through the hosting secret mechanism; keep the value out of source, reports and logs. Visit `/internal/bootstrap` with the matching platform session to explicitly initialize the synthetic team. No configured identity means initialization is denied. Service access tokens without an actual platform user are denied.

The bootstrap creates one team, its first administrator and one synthetic invitation atomically. Invitation raw tokens are returned once to the current session; only SHA-256 token hashes and stable operation IDs are stored. A repeated request never reveals the old token. If its response was lost, use the explicit revoke-and-reissue action; revocation and the replacement invitation share one guarded batch.

### Server interfaces for subsequent packages

`lib/server/domain.ts` exports `createService({ db, bucket?, clock?, bootstrapSiteUserId? })` and `assertGuard(db, operationId, phase, predicateSQL, boundValues?)`. All methods accept an injected trusted `{ subject }` principal, never an actor from JSON. The production adapter `app/api/v1/[...path]/route.ts` calls the preserved official `getChatGPTUser()` first; only its `userId` becomes `subject`. `lib/server/runtime.ts` supplies the actual `DB`/`BUCKET` and bootstrap configuration.

Routes implemented:

| Method and route | Body | Result |
| --- | --- | --- |
| GET `/api/v1/bootstrap` | none | own Site ID, initialized/canBootstrap flags, own `Me` |
| GET `/api/v1/me` | none | own `Me`; no account is created on read |
| POST `/api/v1/internal/bootstrap` | `{discName,jerseyNumber}` | operation, own `Me`, invitation metadata and first-response token |
| POST `/api/v1/join` | `{token,discName,jerseyNumber,returnTo?}` | operation, current own `Me`, sanitized same-origin target |
| PATCH `/api/v1/me` | `{discName,jerseyNumber,expectedVersion}` | operation and current own `Me` |
| POST `/api/v1/admin/invites` | `{}` or `{revokeInviteId}` | first-response token and invitation metadata; admin only |

Writes require JSON, same-origin `Origin`, an `Idempotency-Key` (1–128 ASCII letters/digits/underscore/hyphen), and `X-Kapok-Actor` equal to the currently authenticated Site subject. The actor header is an account-change precondition, never an authentication source. A stale browser form gets `ACCOUNT_CHANGED`/409. `lib/client/api.ts` supplies `api<T>(path, {method,body,key,actorId})`, `ApiError`, and `createRequestKey()` to keep a key stable for the same actor/input after network failure.

Responses use `{data,requestId}` or `{error:{code,message,retryable},requestId}` and `private, no-store`. Pages use `force-dynamic`; no business offline cache or draft storage is enabled in T1. Same-key changed normalized input gives `IDEMPOTENCY_CONFLICT`/409; stale profile versions give `VERSION_CONFLICT`/409. D1 batch assertions unconditionally insert a `write_guards.pass` value constrained by `NOT NULL CHECK(pass=1)`; zero matching updates therefore cause database rollback. Replay reads committed operation results and re-reads the current account/membership rather than repeating invite consumption.

## CP03 T2 training and private media

Apply the new `drizzle/0001_training.sql` after T1; never replay or edit `0000_identity.sql`. T2 adds trainings, ordered Bilibili/private-upload videos, ordinary/time comments with one reply level, report/hide/restore audit, and owner-only collections/private notes. The training, video, growth and recent-training home screens now read/write these real services. Empty, unavailable, archived and failed requests have distinct honest states. Reflections and their sharing/lifecycle remain T3.

`createService` keeps the T1 factory, trusted identity and operation contract. New routes use the same authenticated dispatcher, Origin/account preconditions, idempotency keys and no-store envelope. Training/comment/collection writes reject stale versions; guarded batches assert their final effects and membership epoch. No client-supplied owner, team or role is accepted.

Uploads use `POST /api/v1/uploads {bytes}` → `PUT /api/v1/uploads/:id/content` (raw bytes, same actor/Origin/key) → `POST /api/v1/uploads/:id/complete {}`. Only the uploading administrator may transfer/complete/attach an upload. The bounded receiver uses private R2 multipart parts up to 5MiB; incomplete/quarantined bytes cannot be fetched as media. The immutable content key accepts a retry only when the actual bytes equal the committed upload. A different file requires a new upload. `GET /api/v1/uploads` lists only the current admin's unused reservations; `POST /api/v1/uploads/:id/cancel {}` explicitly cleans them and frees quota. The UI offers progress, retry and cancellation; it does not promise background transfer.

Completion inspects actual ISO-BMFF boxes, nonfragmented H.264 `avc1`/`avcC` with SPS/PPS and NAL lengths, movie/track/sample timing and sample offsets/sizes. Optional audio must declare MPEG-4 AAC-LC through parsed `esds` descriptors; unsupported, encrypted, fragmented, unknown or unverifiable media is rejected. WebM is explicitly unsupported. This is bounded container/codec validation, not transcoding or a universal decoder. The actual synthetic test/playback fixture is a silent 3-second, 320×180 H.264 MP4, 11,546 bytes in `tests/fixtures/synthetic-pass.mp4`; no real people/media were used. AAC audio playback has not been exercised with this fixture.

Limits are 20MiB/file, 60 seconds and 100MiB/team including reservations. Authorized playback streams only through `GET /api/v1/videos/:id/media`; it supports single explicit/open/suffix ranges, 206/416 and private/no-store. Every request rechecks the current membership and training/video state. There are no public object URLs. Bilibili stays an HTTPS BV/page reference with original-site open/copy/manual seconds; no download proxy or simulated seek. Automated orphan expiration and recovery windows remain later lifecycle work; unused reservations can already be explicitly cancelled in the admin UI.

Run `npm run test:integration`, `npm run typecheck`, and `npm run lint`. Tests use isolated real Miniflare D1/R2 and the synthetic MP4, including source loss, private-note ownership even against admin, archived writes, actual byte/codec/time validation, upload replay, Range and access revocation. Controller owns actual build, migrations of the running preview, browser and hosted evidence.

### T2 review fix 1

Apply the append-only `drizzle/0002_upload_cleanup.sql` after 0001. Upload cancellation/rejection now persists a cleanup intent and continues to count its reservation while a receiver is active or R2 abort/delete/head confirmation fails. Pending cleanup stays in the current uploader's unused-upload list with `cleanupState: 'pending'`; retry the same cancel key. Ready, cancelled and rejected transitions each have exact final status/object/version/result guards inside the D1 batch. A late receiver/validator cannot recreate or mark ready a cleaned object. `CLEANUP_PENDING` is an explicit retryable error; automatic expiry remains separate lifecycle work.

H.264 validation additionally parses bounded SPS/PPS RBSP syntax, references, trailing bits, dimensions and each video sample's supported slice header, reference/weight/deblocking/CABAC alignment structure. The supported subset is progressive 8-bit 4:2:0 Baseline/Main/High with supported AVC configuration and an initial IDR sample; interlaced, FMO, parameter replacement and unsupported extensions are explicitly rejected. It is structural verification, not reconstruction of entropy-coded macroblocks or universal decoder compatibility. Damaged SPS/PPS and slice-header byte regressions accompany the same real synthetic MP4 success test.

Collections use a separate published/archived source policy even for an administrator. Withdrawing or hiding a source returns a generic unavailable reference with only the owner's note/seconds; administrator management access remains available separately.

### Private short-clip preflight limits (N1)

Before any codec or sample payload validation, all tracks share a maximum of 10,000 samples. The cumulative declared sample bytes across tracks/chunks must fit the actual combined `mdat` payload and remain within the existing 20MiB physical limit; bounded safe-integer additions reject excessive declarations before payload parsing. These limits apply to the current ≤60-second private format and may reject some otherwise legitimate high-frame-rate or densely sampled clips. Such files return an explicit unsupported-format result; this is not a general video compatibility promise. No codec, dependency or database schema was expanded.

## CP03 T3 personal reflections and current community reads

Apply **only the new** `drizzle/0003_reflections.sql` after the already-applied 0000–0002 migrations. This migration adds private reflections with content/sharing/generation guards, announcements, first-readable video events and membership/account revocation triggers. It rebuilds the collection source-kind CHECK to accept reflection references while retaining existing collection IDs, owners, notes, timestamps and versions. Applied migrations remain unchanged. Drizzle snapshots describe the tables; the SQL migration additionally owns the revocation/event triggers.

Growth now includes automatically owned reflections and separately private collections. Save → author reading uses history replacement and clears only the confirmed account's matching device draft. The local draft stores the immutable pending save key/input before a request, so cold-start recovery confirms the same create rather than creating a duplicate after an unknown response. Later input remains a device draft and updates the original cloud record. Expired sessions conceal content and invalidate old response generations while retaining the account-bound draft and pending save key for verified same-account recovery. A confirmed different account or explicit sign-out clears the affected account's drafts. Explicit sign-out confirms account ownership, clears that account's device drafts and conceals other protected tabs. There is no offline business cache, production role switch, anonymous draft claim or automatic share prompt.

Reflection grants are exclusive private/team; targeted coach grants are removed by the B production revision, while the coach membership role remains. Team reading is separate from explicit activity publication; withdrawing activity keeps team reading. Content/title/date/association save and deletion revoke all grants/publication. All sharing mutations use one D1 batch containing operation insertion, exact version/generation CAS, closed gate, final state update and unconditional CHECK guards. A stale prepared request cannot finish after newer revocation, and a suppressed final UPDATE rolls the entire batch back. Retries read current state. Current membership/author epoch and source state are checked when reading links, directories, activity pages and bookmarks; admins have no private-reflection privilege.

New account-bound JSON responses include `X-Kapok-Actor`. Sensitive client reads and all `api()` writes verify this response identity before parsing content, in addition to server-side official identity and write preconditions. Protected pages begin concealed and revalidate on direct entry, pageshow/focus and visibility recovery. Browser, bfcache, keyboard and hosted/multi-account behavior still require controller verification; the focused client tests prove state/key logic, not a real browser matrix.

Member directory/public profiles list only basic fields and current team grants. Home shows three current activity items; full activity is paginated. Events include only deliberate reflection publications, first-readable videos in currently published trainings, and published announcements. Editing metadata does not refresh event time. Announcement draft/publish/edit/withdraw/delete is available to admins. No social or private-content counts are returned.

T4 owns personal export, seven-day restore, last-admin member operations and lifecycle cleanup. Reflections already soft-delete using `deleted_at`, increment generation and clear sharing. Restore must advance generation/sharing version and restore **private only**, never repopulate old scope/coach/publication; exports must not copy other people's live collection source text. Continue using guarded batches and current membership state, including the new database revocation triggers.

## Kapok CP03 T4 minimal personal data rights

The owner-private synthetic app now provides **My → Privacy and personal data** (`/me/data`): current owner JSON download, own reflection recycle bin (`/me/recycle`), and self-leave distinct from account deletion. Active administrators have a dedicated `/admin/members` page for server-authorized role/status changes. There is no business role switch or administrator private-content export.

- `GET /api/v1/me/export` generates and returns `kapok-personal-v1` in one current-authorized request. Its D1 batch snapshot rechecks the actual platform identity, active account and current owner-reader source availability. It includes only own profile, own reflections, own collection references/notes/seconds and own authored comments. Other authors' bodies, source titles/text, emails, coach recipients and grant internals are excluded. Unreadable sources retain only a stable reference and generic `sourceAvailable:false`. The client checks response actor before parsing and checks its current session generation again before initiating a JSON download. No export job/file is retained, no old payload is reusable, and no task/expiry SLA is claimed. Downloaded files are the user's responsibility.
- `GET /api/v1/me/recycle` lists only the owner's deleted reflections still inside seven days; `POST /api/v1/reflections/:id/restore` takes `{expectedVersion,expectedSharingVersion,expectedGeneration}` and an idempotency key. At the exact seven-day deadline restoration is denied. Restore increments all three counters and returns a private, closed-gate original with no coach, author epoch or publication; a completed-key replay only reads current state. Existing owner deletion already revokes reading/publication immediately. Expired rows are unavailable for restoration even while automated physical cleanup remains pending.
- `GET /api/v1/admin/members` lists basic member fields/status/role/version/epoch for current active admins. `PATCH /api/v1/admin/members/:userId` takes `{role,status,expectedVersion,expectedEpoch}`. `POST /api/v1/me/leave` takes `{expectedVersion,expectedEpoch}`. Writes retain the existing Origin/actor/JSON/idempotency checks and audit only actor/target/action/reason/time, never private text. Current actor and expected target checks, mutation, final-effect guard, remaining-active-admin guard and audit execute inside one D1 batch. Concurrent demotions/leaves cannot remove the last active admin. Admin reactivation from paused/left increments epoch; normal rejoin still consumes an invitation and rotates epoch. T3 triggers revoke outbound/inbound grants; reactivation/reappointment never restores them.

No schema migration is added: T4 uses already-defined tables and leaves migrations `0000`–`0003` unchanged. `npm run test:integration` includes isolated real D1 data-rights/race tests and the production client download-orchestrator regression. Typecheck/lint are the same commands above. Browser/build/local migration remain controller-owned evidence.

This is **minimal personal data rights**, not full P0 or a production claim. Account-wide disable/session revocation, account deletion/cancellation/recovery, automated seven-day expiry/24-hour physical and orphan cleanup, independent encrypted backup/restore and suppression replay, full governance/mute/audit retention, real email/member onboarding, real devices and network conditions remain pending. The app exposes no fake success controls for those operations and promises no unsupported cleanup, export or recovery SLA.

## Current media compatibility revision (PRD G)

This section supersedes the historical T2/N1 demonstration limits and full H.264 syntax-validation description above. Current configured limits are 100 MiB per file, 600 seconds and 1 GiB per team, including reserved bytes and cleanup-pending uploads. The browser sends sequential parts of at most 5 MiB; metadata validation reads bounded object ranges instead of buffering an entire video. Original user-provided samples remain local-only and are never shipped as fixtures.

Acceptance identifies supported MP4 container/media metadata and verifies structural size, duration, sample-table and resource boundaries. It does not decode every H.264 frame, require independently derived duration tables to be identical, or reject ordinary repeated in-band parameter sets. It is not a transcoder, a guarantee that any MP4 is accepted, or proof that every browser can play accepted media. Private Range access, owner/admin checks, quota reservations, incomplete-upload exclusion and cleanup remain enforced.

A lost upload response is an uncertain result: query/retry the same reservation and immutable operation keys rather than create another upload. Cleanup failures keep quota reserved until deletion/abort is confirmed. Ordinary API reads retain a 15-second deadline; upload transport/completion use finite 120-second deadlines with cancellation and late-response fencing. The publication version and actual hosted/browser evidence are recorded separately in CORE-DELIVERY; local integration and parser success do not establish hosted upload or decoding success.


## Resumable upload engineering revision (PRD H)

The deployed admission policy remains **100MiB/file, 600 seconds, 1GiB/team** until the actual Sites resource allowance is confirmed. The trusted local engineering policy can exercise 5GiB/7200 seconds with a 10GiB team budget; request JSON cannot enable it. This does not yet satisfy the user's ordinary long-phone-video hosting need, and does not establish HEVC/universal-phone playback or transcoding.

New reservations bind a full ordered SHA-256 chunk manifest. Browser hashing reads one 5MiB slice at a time. After refresh the owner can select the same original file for a complete content check and continue only missing parts; a fully received upload can continue processing without reselecting the file. Server progress is authoritative, and no browser storage grants access. Existing v5 ready videos remain accessible; unbound legacy incomplete uploads require cleanup/restart.

Immutable staging attempts and generation-specific multipart assembly isolate late writes. Starting a new upload reserves twice its file size for temporary storage and final assembly; uncertain retries can need additional room. Only confirmed cleanup releases the corresponding allocation. At the local 5GiB/10GiB boundary there is no retry headroom. At most two unresolved active attempts per team are admitted; uncertain writes can block until reconciliation. This is not automatic expiry/cleanup or a global isolate-memory guarantee.

Long metadata is processed in durable bounded steps: 64KiB windows, at most16 range reads and4096 traversal iterations per step, 512KiB cache, at most2048 metadata steps. Engineering complexity bounds include32MiB moov and1million combined media samples; exceeding the step bound is a supported-complexity rejection. No full-file/full-moov buffer or frame decoder is used. Local CPU measurements do not establish the actual hosted Worker CPU entitlement.

Apply only the new append-only `drizzle/0004_resumable_uploads.sql` after0000–0003. It adds protocol state, immutable part commitments, attempts and indexed assembly receipts; prior rows and migrations are retained. Use the existing local migration command above; native publication applies hosting migrations separately. The isolated integration suite checks old-ready preservation. Migration failure recovery must be assessed separately from upload-operation transaction rollback. Run `node --test --test-concurrency=1 tests/integration/*.test.mjs` if local parallel Miniflare fixtures exhaust loopback connections; the flag must precede the test glob.

Evidence distinguishes actual110MiB/22-part local transfer, actual8MiB carrier with188 durable long-metadata steps, and virtual2/5GiB offset/5GiB-admission tests. Actual5GiB full hashing/transfer and real long-video decoding/seek remain unverified. Exact release evidence, remaining risks and resource decision are in external LONG-VIDEO-DELIVERY and CORE-DELIVERY.

## Selected B production revision

Apply only append-only `drizzle/0005_two_scope_reflections.sql` after 0000–0004, using the local migration command above. It installs INSERT/UPDATE fences against coach grants and clears legacy directed authorization and publication in one revocation UPDATE, including deleted rows. It preserves body, author, association, content version and generation while advancing sharing version; existing private/team grants are unchanged. Never restore a legacy grant or widen it to team.

Native publication applies migrations before Worker upload. A failed deployment may already have applied a migration: reconcile the native migration/deployment state before retrying, never blindly replay a partial file or roll back to pre-v6 code. Local batch rollback is covered by integration tests; native full-file failure atomicity is not established.

The selected B package adds `/me/edit`, default initial avatars, single-level discussion replies and verified optional video seeking. Photo upload and PWA are not implemented. Long-video capacity work is paused; the existing 100MiB/file, 600-second and 1GiB/team limits and v6 upload protocol remain in force. This does not meet the deferred 40-minute training-video requirement.
