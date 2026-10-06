# Latest Updates operations guide

Module version: **1.0.0**. Canonical source: Ekselera `src/features/latest-updates/`. This guide is copied unchanged into Ziffa by the sync command. The publishing Worker lives only in the Ekselera repository, under `workers/latest-updates-publisher/`.

## Architecture and ownership

Cloudflare Email Routing → publishing Worker → private R2 draft and D1 ledger → DMARC-gated invitation → explicit author POST → Queue → GitHub App content PR → Astro validation → squash merge → serialized Cloudflare Pages deployment → custom-domain verification → Resend notification/Broadcast.

Git is the public content source. D1 contains private authorization, consent and processing records; R2 holds temporary private attachments. Queue delivery is repeatable. The five-minute reconciler resumes unfinished jobs. The service never uses an LLM to interpret email instructions.

| Site | Publishing address | Article directory | Public images |
| --- | --- | --- | --- |
| Ekselera | `post@publish.ekselera.com` | `src/content/updates/` | `public/latest-updates/media/<post-id>/` |
| Ziffa | `post@publish.ziffa.io` | `astro_landing/src/content/updates/` | `astro_landing/public/latest-updates/media/<post-id>/` |

The SMTP recipient chooses the website. Authors cannot change the destination through their attachment. Private author mailboxes belong in the Worker secret `AUTHORS_JSON`; public names belong in each website’s `src/config/latest-updates.ts`. Neither email addresses nor confirmation tokens enter Git or the public manifest.

## Write and publish an article

Use your explicitly approved, direct sending account. Send to exactly one publishing address in To, with no Cc/Bcc or forwarding. The visible From and SMTP envelope sender must match your approved mailbox. Bounce aliases and relaying arrangements are unsupported in v1.

```text
From: your-approved-mailbox
To: post@publish.ziffa.io
Subject: A faster way to process supplier invoices
Attachments: update.md, workflow.png
```

`update.md`, saved as UTF-8:

```markdown
We have improved how supplier invoices are processed.

## What changed

The new workflow makes it easier to check each document.

![The new invoice processing workflow](workflow.png)
```

The subject supplies the title, up to 180 characters. The email body/signature is ignored. Attach exactly one `.md` file, without frontmatter. Ordinary paragraphs, headings, lists, quotations, links, fenced code, tables and ordinary/reference-style images are supported. Raw HTML, MDX, unsafe URL schemes and remote images are rejected.

Limits: raw message **10 MiB**, Markdown **128 KiB**, **five** images maximum, **2 MiB** per image. Images must be PNG, JPEG or WebP with matching extension and actual format, unique simple filenames, no directories/traversal, and meaningful alt text. Missing images, duplicate names and unsupported attachments fail validation. Unused images appear as warnings and are excluded.

Common rejection messages include `Attach exactly one UTF-8 .md file`, `Image must reference an attached image by filename`, `Image requires descriptive alt text`, `Raw HTML is unsupported`, `Unsafe link URL`, and `Sender is not authorized or envelope differs`.

Cloudflare must accept the automatic reply before the draft becomes publishable. Its `reply()` method enforces the receiver’s DMARC requirement. Sender-supplied authentication headers and Reply-To are ignored; Resend is never used as a fallback for this invitation.

Open the private link, check the destination, author, title, images and summary, then press **Publish to Ekselera/Ziffa**. Opening the link makes no change. Publish and Discard use same-origin POST requests. The random token is stored only as a SHA-256 hash, bound to the site and immutable content digest, and expires after 24 hours. Private preview/media responses use no-store/noindex/no-referrer and restrictive CSP.

The publication timestamp is assigned when Publish is pressed, stored in UTC, displayed in Europe/Malta. A short stable ID suffix makes the title-derived slug unique. The slug never changes after publication. The opening prose supplies the summary, capped at 240 characters at a word boundary.

The status progresses through `awaiting_confirmation`, `confirmed`, `opening_pr`, `validating`, `merging`, `deploying`, and `live`. `discarded`, `expired`, `failed`, and `needs_attention` are terminal or operator-controlled states. Repeated clicks/deliveries reuse the same recorded operation. A reused Message-ID with different article attachments/title is rejected.

## Websites and styling

`/latest-updates/` lists newest articles first; `/latest-updates/<slug>/` renders an article. The same published collection query powers routes, desktop/mobile navigation and footer links. Astro’s sitemap sees only generated routes.

With zero articles, no Updates route or link is generated. Each site ships `404.html` to prevent Pages’ implicit SPA fallback. Removing the last article and rebuilding hides the section again. `latest-updates-manifest.json` is still generated, with an empty list.

The shared module owns scoped article hierarchy, approximately 780 px reading width, responsive 18–20 px prose, explicit list/table/code/image styles and subscription markup. Each site owns its layout, typography, brand configuration and button styles. Ekselera keeps its white/blue appearance and 80 px fixed-header clearance; Ziffa keeps its paper/ink/gold appearance and sticky-header layout. Links use underlined ink for contrast. Preview uses the same Markdown renderer and scoped CSS; local preview fonts are provided by the service. No third-party scripts or remote article images appear in previews.

## Local commands

From Ekselera’s repository root:

```sh
bun install --frozen-lockfile
bun run updates:validate
bun run updates:test
bun run publisher:check
bun run publisher:test
bunx astro check
bun run build
bunx wrangler types workers/latest-updates-publisher/worker-configuration.d.ts --config workers/latest-updates-publisher/wrangler.jsonc --env staging --include-runtime false
bunx wrangler deploy --dry-run --config workers/latest-updates-publisher/wrangler.jsonc --env staging
```

From Ziffa’s `astro_landing/`, use `updates:validate`, `updates:test`, `astro check` and `build`. Worker commands remain in Ekselera. `bun run deploy` requests the serialized GitHub deployment workflow; it does not launch a competing local Pages deployment.

For Worker development, copy `.dev.vars.example` to `.dev.vars` in the Worker directory and fill private configuration locally. Never commit it. Apply migrations and start Wrangler from that directory:

```sh
bunx wrangler d1 migrations apply latest-updates-staging --env staging --local
bunx wrangler dev --env staging
```

Local HTTP tests must use a service hostname configured in `SITES_JSON`; unknown Host headers return 421. Local development never proves receiver DMARC behavior: test that using an actual staging email address and the real author mailbox.

## Synchronize the reusable module

From the canonical Ekselera root:

```sh
bun run updates:sync /Users/danielmicallef/edev/ziffa/astro_landing --dry-run
bun run updates:sync /Users/danielmicallef/edev/ziffa/astro_landing
```

The command copies only shared feature files, the validator, sync tool and this guide. It records version and file hashes in `.latest-updates-module.json`. It refuses to overwrite local changes, verifies Astro 5/dependencies/integration points, and preserves public author profiles, theme configuration, content, images and all unrelated site code. Resolve local module differences in the canonical source before syncing. `--install` is only for the first installation, before thin route/collection/navigation adapters exist; it still checks dependencies and refuses unexplained overwrites. The initial adapters are checked in separately and are not regenerated by subsequent syncs.

## Provision Cloudflare without disrupting existing mail

Run `bunx wrangler whoami` first. DNS/Email Routing changes require appropriate zone and email-routing permissions in addition to Worker/D1/Queue/R2 permissions. Do not print credentials. The repeatable provisioning command inspects resource names before creation and records identifiers in `workers/latest-updates-publisher/resources.json`:

```sh
bun run scripts/updates-provision.ts --dry-run
bun run scripts/updates-provision.ts --apply
```

Separate staging and production D1 databases, private EU R2 buckets, Queues and dead-letter queues are required. `wrangler.jsonc` references these resources; apply the migration to each environment explicitly. Never expose an R2 public URL or custom domain for drafts. The Worker uses a five-minute cron and bounded Queue batches. Create staging branches/domains/Segments/Topics separately; staging config rejects `main` and production origins and never creates subscriber Broadcasts. Controlled test recipients must be listed in `STAGING_RECIPIENTS_JSON`.

Deploy the validated Worker to staging first. For production, configure exact custom domains `publishing.ekselera.com` and `publishing.ziffa.io`. Configure the `publish.ekselera.com` and `publish.ziffa.io` subdomains in Cloudflare Email Routing, add only the returned subdomain MX/TXT records, then exact recipient rules to the production Worker. Do not change Ekselera’s Google apex MX or Ziffa’s existing Cloudflare apex routing. No catch-all rule is needed.

The routing command uses the Cloudflare API with a locally supplied `CLOUDFLARE_API_TOKEN`, reads existing routing and DNS records, and creates only missing exact resources:

```sh
bun run scripts/updates-routing.ts --dry-run
bun run scripts/updates-routing.ts --apply
bun run scripts/updates-routing.ts --staging --dry-run
bun run scripts/updates-routing.ts --staging --apply
```

`--staging` creates only `staging-post@publish.ekselera.com` and `staging-post@publish.ziffa.io` rules targeting the staging Worker; configure those exact recipients in staging `SITES_JSON`. Give each staging site a distinct service hostname (for example `publishing-staging.ekselera.com` / `publishing-staging.ziffa.io`) through staging Worker custom domains. Alternatively test one site at a time using the deployed workers.dev host; two site configurations cannot share a service hostname. These rules use the same inbound DNS but separate recipient addresses and Worker resources.

Verify subdomain MX/TXT records and exact Worker rules in Cloudflare, then send a new email from each approved mailbox and follow the invitation. Do not enable production merely because DNS or a dry-run build succeeds. See [Cloudflare subdomain routing](https://developers.cloudflare.com/email-service/configuration/subdomains/) and [receiver reply requirements](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/).

## GitHub App and deployment setup

Create/install one GitHub App restricted to `danielMicallef/ekselera` and `danielMicallef/ziffa`, with Contents write, Pull requests write and Actions read; Metadata read is implicit. No administration/workflow-write permission is needed. Record App ID and installation IDs; store its private key as a Worker secret. Tracking issues are Ekselera #2 and Ziffa #682. Publication branches are `feat/<issue>-publish-<post-id>`.

The service builds one Git tree/commit containing only the generated Markdown and referenced image bytes. Retries discover existing refs and PRs. Before merge it checks every changed path/status, file bytes, expected head, successful `latest-updates-check.yml` workflow and the exact tested-head/base artifact. An advanced base triggers a branch update and revalidation. Unexpected edits prevent merge. App-authenticated squash merges use `docs(latest-updates): <title>`, emit a real push event, and preserve Ziffa’s protection.

Both repositories contain `latest-updates-check.yml`, `latest-updates-callback.yml` and `latest-updates-deploy.yml`. The callback executes only default-branch code; its timestamped HMAC is replay checked, and serves only as a reconciliation signal. Lost callbacks are recovered by cron. Ziffa’s Django/image/release workflows ignore only article and media paths; mixed changes and release tags retain normal behavior.

Set repository variable `UPDATES_SERVICE_ORIGIN` to the correct publishing hostname and `UPDATES_DEPLOY_ENABLED=true` only after staging passes. Set repository/environment secrets `UPDATES_CI_CALLBACK_SECRET`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. The deployment token needs Pages deploy access. Use one serialized workflow; it skips superseded commits, rechecks current `main` immediately before deploying, and includes `--commit-hash`. Inspect existing Cloudflare Pages Git build settings and disable duplicate automatic builds only when this workflow is ready to replace them. Route ordinary manual deploys through this workflow.

For isolated staging, create `latest-updates-staging` in each repository and point the staging Worker at that branch and the stable Pages preview origins `https://latest-updates-staging.ekselera.pages.dev` / `https://latest-updates-staging.ziffa.pages.dev`. Set `UPDATES_STAGING_DEPLOY_ENABLED=true`, `UPDATES_STAGING_SERVICE_ORIGIN` and `UPDATES_STAGING_CI_CALLBACK_SECRET`. The callback selects its environment by the PR base branch. The deployment workflow uses the staging GitHub environment and a Pages preview branch, never the production alias. Configure separate staging environment deployment credentials and staging Worker resources/site settings. Publish the Worker workflows to `main` before testing this path; workflow-run callbacks execute trusted default-branch code.

The service verifies the manifest’s post ID/digest, article response, every image’s bytes, and homepage navigation on the custom production domain using cache revalidation/cache-busting. A commit, merge or deploy command does not prove publication. Subscriber failures do not trigger another article publication.

## Configuration, secrets and rotation

Public site settings live in each website’s `src/config/latest-updates.ts`. Worker site settings are typed in `src/config.ts`; use `sites.example.json` as the template for `SITES_JSON`. It includes recipient, origins, repository/branch, content/media prefixes, Pages project, GitHub installation/tracking issue, Segment/Topic IDs, sender, business postal address and brand colors. Inactive configuration uses an empty site list. Do not infer sender identities or author permissions from local Git/account ownership.

Worker variables: `ENVIRONMENT`, `SITES_JSON`, `PUBLISHING_PAUSED`, `DELIVERY_PAUSED`.

Worker secrets: `AUTHORS_JSON`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `CI_CALLBACK_SECRET`, `STAGING_RECIPIENTS_JSON`.

Example author configuration (replace placeholders explicitly):

```json
[{"id":"author-id","email":"approved-mailbox","name":"Public display name","sites":["ekselera","ziffa"]}]
```

Use `wrangler secret put NAME --env staging/production` from the Worker directory, entering values interactively or through a secure secrets manager. Never paste private keys into command arguments, logs, this guide or chat. Rotate by creating new provider keys, installing secrets, testing staging, then revoking old keys. Rotate the shared CI callback secret in GitHub and Worker together. Existing confirmation tokens do not depend on provider keys.

Remove an author from `AUTHORS_JSON` to revoke outstanding drafts; authorization is checked again at confirmation and before opening a PR. Add their public display profile separately. Never leave a production author enabled before their real direct sending account has passed the invitation test.

## Resend subscriptions

Use the existing verified sending domains and explicitly chosen sender identities. Never enable Resend receiving on these publishing subdomains. Leave the existing General Segment untouched. These separate production resources have been created with Topic defaults **opt_out**:

| Site | Segment ID | Topic ID |
| --- | --- | --- |
| Ekselera | `bc122266-7bb8-4ebf-b9b2-37aa801b5cd8` | `5fe52908-96f9-4d57-83d3-74f1bd369151` |
| Ziffa | `f0abff40-9918-4bd6-a9e5-2bcea62cd9c3` | `b4fc0220-0b06-470f-a702-51a9bc072d66` |

Submitting the branded form sends a double-opt-in invitation. GET displays information; same-origin POST consumes the 24-hour token. Confirmation records time/consent version and adds only the destination Segment and Topic. Responses to requests do not disclose existing subscriptions. Source/address rate limits and a honeypot constrain abuse; CORS permits only the site origin. Privacy pages explain Cloudflare/Resend processing.

Existing global unsubscribes and local bounce/complaint suppressions remain in force. No existing leads are enrolled; unrelated preferences are preserved. Configure a signed Resend webhook to `/webhooks/resend` on one service hostname for contact/preference changes, bounces and complaints. The service validates the raw payload, records event IDs and never restores opt-ins from webhook events. Resend remains authoritative for per-Topic preferences and suppressions.

Every verified live pipeline post has one recorded draft Broadcast targeting **both** its Segment and Topic. It contains title, summary, canonical URL, HTML/plain text and native unsubscribe/preferences link. Leaving one Topic leaves the other site’s preference intact; global unsubscribe stops both. No historical backlog is sent. Manual Git edits, redeploys, rollbacks and restored IDs never create a Broadcast.

## Recovery, pause and retention

Pause new PRs/merges with `PUBLISHING_PAUSED=true`; pause author/newsletter sends with `DELIVERY_PAUSED=true`. Existing public articles remain available. Resume only after the underlying issue is understood. The reconciler enqueues unfinished job IDs; D1 uniqueness/CAS transitions and per-job leases guard duplicates.

Use D1 to inspect `jobs`, `outbox`, `events`, and `subscriptions` without exporting private bodies to logs. Queue retries are bounded; failed attempts reach a separate DLQ. To replay, first inspect the recorded branch/PR/head, production manifest and Resend state, clear the cause, then deliberately enqueue **the same job ID** using the signed callback (set `CI_CALLBACK_SECRET` and `PUBLISHING_SERVICE_ORIGIN` through your secrets manager first):

```sh
node scripts/updates-replay.mjs <existing-job-uuid>
node scripts/updates-replay.mjs <existing-job-uuid> --apply
```

The first command is a dry run. Replay does not clear failure/attention states or reset notifications. If checks have been fixed and independently verified, an operator may move a `needs_attention` job back to its appropriate checkpoint using a reviewed D1 update, clearing `retry_count` and `error_code`. Preserve PR/Broadcast IDs and digests. Do not reset an ambiguous send state until provider evidence establishes its outcome. Never create a new article job to recover a send failure. A `needs_attention` job requires an operator’s explicit state correction after establishing the actual outcome.

Author notification sends use provider idempotency keys. If a send outcome is uncertain, the service stops rather than automatically resending after the provider’s idempotency window. Inspect provider logs and record the established outcome. Broadcasts persist their provider ID before sending; uncertain send states query that ID. If it is already sent/queued, mark delivered processing complete; if its outcome cannot be proved, leave `needs_attention`. An uncertain draft creation can leave an orphan **unsent** draft; inspect its unique site/post name, attach its ID deliberately, and never blindly create/send another campaign.

Confirmation preference writes also stop for attention on uncertainty: blindly replaying an opt-in could override a later opt-out. Ask for a fresh deliberate confirmation when safe. Provider outages must not create a new post or re-enroll contacts.

Completed article bodies are redacted after seven days once notifications finish. Private R2 files from live/expired/discarded/failed jobs are removed after seven days. Unfinished or attention jobs retain media for investigation. The minimum publication ledger remains to prevent repeat publication/broadcasts. Rate-limit buckets expire; unconfirmed subscription invitations are removed after seven days past expiry. Use D1 Time Travel/backups and private R2 backups before maintenance. Export private data only to a secure, untracked location:

```sh
bunx wrangler d1 export latest-updates-production --env production --remote --output /secure/location/latest-updates.sql
bunx wrangler d1 time-travel info latest-updates-production --env production
```

For restoration, first pause publishing/delivery and queue delivery, preserve a fresh backup, then use the D1 Time Travel bookmark selected from the incident timeline:

```sh
bunx wrangler queues pause-delivery latest-updates-production
bunx wrangler d1 time-travel restore latest-updates-production --env production --bookmark <verified-bookmark>
bunx wrangler queues resume-delivery latest-updates-production
```

Run pause before restoring and resume last, after reconciliation. R2 has no automatic historical draft restore in this implementation: keep an encrypted private copy via your account’s approved R2/S3 backup process. Restore keys under their original `<job-id>/<filename>` paths and verify their recorded digests before replay. Restore D1 first, reconcile provider/Git state before resuming queues, and never restore older subscription records into Resend as opt-ins.

For a rollback, redeploy the reviewed intended Git revision through the serialized workflow; normally revert the offending change on main so the workflow’s current-main check remains valid. Restoring an article does not resend newsletters. Keep its stable ID/slug.

Retention checkpoints keep the seven-day cleanup progressing through successive batches. Cleanup clears private Markdown and attachments for expired, discarded, failed, live and attention jobs, while retaining the minimal operation IDs, digests and delivery ledger. A job whose source has been cleaned cannot be blindly replayed: restore its original private source from an approved backup and verify the recorded digest, or complete the correction through a reviewed Git PR after establishing the actual Git/provider outcome.

## Corrections and removals

V1 email publishing creates new articles only. Correct/remove a post through a reviewed Git PR. Preserve its post ID and slug for corrections. Update summary/digest using `bun run scripts/updates-reseal.ts <article.md>`, then validate/build. Review changes to referenced image bytes and metadata together. Remove orphan media only when no article references it. Removing the last article hides navigation and all Updates routes. These manual changes do not create publishing jobs or Broadcasts.

## Troubleshooting and rollout gate

- Missing invitation: check exact recipient/routing, author/site allowlist, From/envelope consistency, direct sending account DMARC, size/attachment validation and pause/configuration state. A failed reply leaves no publishable draft. Send a new corrected email with a new Message-ID.
- Broken preview images: check filename case, actual type/extension, reference definitions, alt text and R2 permissions. Do not substitute remote images.
- Failed checks: inspect the recorded PR/head, content-only validator, Astro diagnostics and tested-base artifact. Unexpected edits require review; never bypass checks.
- Delayed deployment: inspect workflow enablement/secrets, superseded revision, duplicate Pages auto-builds, custom-domain manifest and caches. Cron recovers lost callbacks.
- Delivery failure: check the recorded Broadcast ID/provider state, sender verification, Topic/Segment configuration and suppressions; never republish the article.

Production enablement requires: configured public author profiles, private authorized mailboxes, senders and business postal address, installed GitHub App/private key, per-site installation IDs, Worker/provider/callback secrets, exact email rules/DNS, custom service domains, repository deployment secrets/settings, signed Resend webhook, and real-mailbox staging acceptance. Until then allowlists remain empty and publishing/delivery/deployment switches remain off.

Acceptance includes zero/one/multiple articles on both sites; 360/768/1280 px layouts, keyboard and 200% zoom; rendering fixtures with Unicode/code/table/quotes/images; forged/ambiguous/forwarded/expired/replayed inputs; scanner-safe GETs; revoked authors; duplicate clicks, stale heads/base changes and unexpected PR edits; deployment failures/cache verification; independent subscriptions/global suppression; replayed webhooks/provider timeouts; cleanup, DLQ and pause/resume. Automated test results and remaining live prerequisites are recorded in the canonical Ekselera repository’s `docs/latest-updates-validation.md`. Real mailbox and provider delivery tests cannot be replaced by mocks.

No sample articles or imported subscribers are enabled in production. Publish the first real article only after staging passes, then verify its page, navigation, image responses and subscriber delivery.
