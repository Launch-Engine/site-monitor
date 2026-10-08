# Site monitor

Watches every LaunchEngine-managed website from one place, and gives every
site repo the same pull request check. Add a site here once; nothing to copy
into the site itself except a five-line workflow.

## What runs

**Monitor** (`.github/workflows/monitor.yml`), every hour and on every push
to main. For each site in `sites.json`:

- key pages answer with the expected status, and are not a Netlify edge
  function crash page
- redirects (www to bare domain, old paths) still hold
- the TLS certificate has more than 14 days left
- the published Netlify deploy is in state `ready`
- the live deploy's commit is the head of the repo branch, when `repo` is set
  and `GH_READ_TOKEN` can read it

Read-only. Failures go to Slack, or to GitHub's failure email when the Slack
secret is not set. One run covers every site, so the cost does not grow with
the number of sites.

**Site check** (`.github/workflows/site-check.yml`), called from each site
repo on pull requests. Builds the site, serves it, and opens every page from
`sitemap.xml` in Chromium at phone (375px) and desktop (1440px) width. Fails
when a page does not load or is wider than a phone screen. Script errors are
printed but do not fail the check, because third-party embeds throw.

## Adding a site

1. Add an entry to `sites.json`. Only `name`, `url` and `pages` are required.
   Add `repo` and `branch` to get the "did the merge actually deploy" check.
   Add `netlify` (site ID) only when the site's host does not match its
   Netlify custom domain.
2. Drop this file into the site repo as `.github/workflows/site-check.yml`:

   ```yaml
   name: Site check
   on: [pull_request]
   jobs:
     check:
       uses: Launch-Engine/site-monitor/.github/workflows/site-check.yml@main
   ```

   A Next.js site passes its build and serve commands:

   ```yaml
       with:
         build: npm ci && npm run build
         serve: npm start -- -p 4173
   ```

3. Protect `main` in the site repo so the `pages` check must pass before
   merging. The reusable workflow can only be called from repos in the
   Launch-Engine org; sites in other orgs (Supra, Elite Realty, Dream Team)
   get the hourly monitor but not the PR check.

## Secrets (org level, set once)

| Secret | Purpose | Required |
|---|---|---|
| `NETLIFY_AUTH_TOKEN` | reads published deploy state across both Netlify teams | for deploy checks |
| `SLACK_ALERT_WEBHOOK_URL` | where failures are posted | no, email fallback |
| `GH_READ_TOKEN` | fine-grained token with read access to the site repos, for the drift check | no, drift check skipped |

## Running by hand

```
node check.mjs                 # every site
node check.mjs danberry        # one site
NETLIFY_AUTH_TOKEN=... node check.mjs
```

Trigger the monitor on demand from the Actions tab, or:

```
gh workflow run monitor.yml -R Launch-Engine/site-monitor
```

## Related

The LaunchEngine Workspace app has its own deeper check in
`Launch-Engine/le-workspace/.github/workflows/deploy-check.yml` (API health,
mail worker heartbeat, sign-in rules). This monitor only confirms its site
URL serves.
