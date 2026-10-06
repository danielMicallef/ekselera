# Latest Updates validation record

Validated on 6 October 2026. The feature is integrated in both repositories; production publishing and delivery are **not enabled**. No example articles, author identities, subscribers or real email sends were installed.

## Automated checks

- **34 publisher tests passed**, including real Miniflare/D1 HTTP tests: scanner-safe GETs, atomic Publish/Discard, revoked/expired/modified invitations, sender consistency, signed callback/webhook checks, suppression replay safety, PR path/content/head/base checks, merge timeout recovery and Broadcast reconciliation.
- **14 shared Markdown tests passed on each site**: ordinary/reference images, dimensions, GFM tables/quotes/code, Unicode, summaries, Malta dates, forbidden HTML/frontmatter/URL schemes, missing images and traversal.
- Worker TypeScript check and Wrangler production bundle passed.
- Both websites passed content validation, `astro check` and full builds. Ziffa retains two pre-existing unused-variable hints; no Astro errors or warnings were introduced.
- Both sites built with zero, one and two temporary articles. Temporary public author profiles, Markdown and images were removed after testing; the final build contains zero articles.
- The synchronization command was exercised against Ziffa. Dry run passed. A temporary target with a modified owned stylesheet was rejected before any writes and retained its local edit.

Publisher HTTP tests need permission to bind a local socket. A sandboxed run failed with `listen EPERM`; the same suite passed with local socket access. This was an environment restriction, not an assertion failure. A later local macOS dependency-executable stall was resolved by running an identical verified copy of esbuild; the fresh bundle and all 34 publisher tests passed.

## Browser and Pages checks

Chrome inspected each site's index and article at **360, 768 and 1280 px**. Fixtures included a long Unicode title, image, quotation, lists, wide table and long code line. No page-level horizontal overflow was detected; code and tables scroll within the article. Backgrounds, typography and header spacing remain brand-specific.

Keyboard navigation reached the labeled email input with visible focus. A **CSS zoom of 200%** was checked without overflow; this is an approximation, not a native browser-zoom accessibility audit. Pending, success and error subscription UI states used intercepted local responses, not live provider delivery.

Cloudflare Pages' local runtime returned a genuine **404** for `/latest-updates/` with zero articles on both sites. Updates links were absent, sitemaps excluded updates URLs and public manifests were empty. Baseline homepages were built from the original Git revisions; before/after comparisons at 360 and 1280 px showed unchanged homepage typography, background and navigation-link geometry.

Evidence:

- [Responsive measurements](validation/latest-updates/browser-results.json)
- [Keyboard and CSS zoom measurements](validation/latest-updates/keyboard-zoom-results.json)
- [Empty-section and homepage regression results](validation/latest-updates/empty-regression-results.json)
- [Ekselera article, desktop](validation/latest-updates/ekselera-article-1280.png), [mobile index](validation/latest-updates/ekselera-index-360.png)
- [Ziffa article, desktop](validation/latest-updates/ziffa-article-1280.png), [mobile index](validation/latest-updates/ziffa-index-360.png)

The evidence directory also contains both sites' index/article screenshots at all three widths, mobile menus, subscription states, CSS zoom, and homepage baseline/comparison screenshots. Screenshots use temporary fixtures and do not imply a live publication.

## Resources provisioned

- Isolated staging and production D1 databases with all schema migrations applied.
- Private EU R2 buckets, primary Queues and dead-letter Queues for each environment.
- Paused staging Worker deployed with empty site configuration, five-minute reconciliation and Queue bindings. Version `5f8ae898-0d7d-4d0e-9808-167f503243b7`.
- Separate production Resend Segments and opt-out-by-default Topics for both sites. Existing General Segment and contacts were untouched.
- GitHub tracking issues: Ekselera #2 and Ziffa #682.

Resource identifiers are in `workers/latest-updates-publisher/resources.json` and the [operations guide](latest-updates.md). Existing apex MX/routing and Pages build settings were preserved.

## Remaining activation prerequisites and live acceptance

1. Explicit approved author mailboxes, public display names and permitted sites; newsletter sender identities and business postal address.
2. Restricted GitHub App installation IDs/private key and callback secrets; GitHub Pages deployment credentials and repository variables.
3. Resend API key, signed webhook and isolated staging subscription resources/test recipients.
4. Cloudflare Email Routing/DNS write access. The available Wrangler OAuth session lacks Email Routing write permission. Publishing subdomain addresses/rules have **not** been created.
5. Configured staging site origins/branches and secrets, then real direct-mailbox tests of Cloudflare's DMARC-gated `reply()` and private confirmation flow.
6. Full staging PR → CI → merge → deployment → custom-domain verification → test-recipient delivery. Test independent Topic opt-outs/global suppression using actual provider preferences.
7. Exercise lost callbacks, upstream timeouts, dead-letter inspection/replay, retention cleanup, pause/resume and database restoration against staging resources.
8. Review native 200% browser zoom and final real content; enable the serialized deployment workflow and replace duplicate Pages Git builds only after the new deployment path works.
9. Configure production service domains and exact publishing addresses, validate every real author mailbox, then enable production with no imported subscribers or sample posts.

Local mocks prove application decisions, not Cloudflare receiver authentication or third-party delivery. An HTTP smoke test of the deployed staging URL returned `421 Unknown host`, as expected with empty site configuration. The staged Worker currently rejects unknown hosts and cannot publish/send; deploying it does not establish the complete live workflow. Follow the [operations guide](latest-updates.md) to complete these prerequisites safely.
