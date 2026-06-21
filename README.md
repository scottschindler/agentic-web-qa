# Agentic Web App QA

Agentic Web App QA is an Eve browser agent and reusable GitHub Action that audits web app previews with Playwright.

Give it a URL. It opens Chromium, optionally logs in with a test account, crawls a bounded set of same-origin pages, clicks safe visible controls, records browser/runtime failures, saves screenshots, and writes Markdown plus JSON reports.

The goal is not to replace a full Playwright suite. The goal is a useful first autonomous smoke test for preview deployments.

## What It Catches

- Console errors
- Unhandled page errors
- Failed network requests
- HTTP 4xx/5xx navigations
- Blank pages
- Click failures
- Broken same-origin links discovered during the crawl
- Destructive-looking controls that were intentionally skipped

It skips controls whose label looks destructive, such as delete, refund, pay, purchase, send, publish, archive, logout, or cancel subscription.

## Quick Start: Audit Any URL

```yaml
name: Agentic Web App QA

on:
  workflow_dispatch:
    inputs:
      url:
        description: URL to audit
        required: true

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - name: Audit URL
        id: qa
        uses: scottschindler/agentic-web-qa@main
        with:
          url: ${{ inputs.url }}

      - name: Upload QA artifacts
        uses: actions/upload-artifact@v4
        with:
          name: agentic-web-app-qa
          path: .agentic-web-app-qa
```

The action writes a Markdown report, a JSON report, and screenshot artifacts.
By default these land in `.agentic-web-app-qa` in the caller workspace.

## Vercel Preview PRs

If your repo is connected to Vercel Git integration, Vercel emits a GitHub `deployment_status` event when a Preview Deployment is ready. This workflow audits that preview URL and posts one sticky PR comment.

Create `.github/workflows/agentic-web-app-qa.yml` in the web app repo you want to audit:

```yaml
name: Agentic Web App QA

on:
  deployment_status:

permissions:
  contents: read
  deployments: read
  issues: write
  pull-requests: read

jobs:
  audit-vercel-preview:
    name: Audit Vercel preview
    runs-on: ubuntu-latest
    if: >
      github.event.deployment_status.state == 'success' &&
      github.event.deployment_status.environment_url != '' &&
      !contains(github.event.deployment.environment, 'Production')

    steps:
      - name: Audit preview URL
        id: qa
        uses: scottschindler/agentic-web-qa@main
        with:
          url: ${{ github.event.deployment_status.environment_url }}
          max-pages: 5
          max-clicks-per-page: 8
          fail-on-findings: false

      - name: Upload QA artifacts
        uses: actions/upload-artifact@v4
        with:
          name: agentic-web-app-qa
          path: .agentic-web-app-qa

      - name: Find pull request for deployment commit
        id: pr
        uses: actions/github-script@v7
        with:
          script: |
            const { owner, repo } = context.repo;
            const sha = context.payload.deployment.sha;
            const response = await github.rest.repos.listPullRequestsAssociatedWithCommit({
              owner,
              repo,
              commit_sha: sha,
              mediaType: { previews: ["groot"] },
            });
            const pr = response.data.find((item) => item.state === "open") ?? response.data[0];
            core.setOutput("number", pr ? String(pr.number) : "");

      - name: Comment audit report on PR
        if: steps.pr.outputs.number != ''
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require("node:fs");
            const marker = "<!-- agentic-web-app-qa -->";
            const report = fs.readFileSync("${{ steps.qa.outputs.markdown-path }}", "utf8");
            const body = `${marker}\n${report}`;
            const { owner, repo } = context.repo;
            const issue_number = Number("${{ steps.pr.outputs.number }}");

            const comments = await github.paginate(github.rest.issues.listComments, {
              owner,
              repo,
              issue_number,
              per_page: 100,
            });

            const existing = comments.find((comment) =>
              comment.user?.type === "Bot" && comment.body?.includes(marker)
            );

            if (existing) {
              await github.rest.issues.updateComment({
                owner,
                repo,
                comment_id: existing.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner,
                repo,
                issue_number,
                body,
              });
            }
```

Start with `fail-on-findings: false`. Once you trust the signal, set it to `true` to turn findings into a failing check.

## Login-Protected Apps

Use a low-permission test account. Do not use a real production user with destructive permissions.

```yaml
- name: Audit preview URL
  uses: scottschindler/agentic-web-qa@main
  with:
    url: ${{ github.event.deployment_status.environment_url }}
    login-url: ${{ secrets.QA_LOGIN_URL }}
    username: ${{ secrets.QA_USERNAME }}
    password: ${{ secrets.QA_PASSWORD }}
    username-selector: ${{ secrets.QA_USERNAME_SELECTOR }}
    password-selector: ${{ secrets.QA_PASSWORD_SELECTOR }}
    submit-selector: ${{ secrets.QA_SUBMIT_SELECTOR }}
```

Typical selectors:

```text
QA_USERNAME_SELECTOR=input[name=email]
QA_PASSWORD_SELECTOR=input[name=password]
QA_SUBMIT_SELECTOR=button[type=submit]
```

## Action Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `url` | yes | | URL to audit. |
| `max-pages` | no | `5` | Maximum same-origin pages to visit. |
| `max-clicks-per-page` | no | `8` | Maximum visible non-link controls to click per page. |
| `output-dir` | no | `.agentic-web-app-qa` | Report/artifact directory in the caller workspace. |
| `install-browsers` | no | `true` | Install Playwright Chromium and OS dependencies. |
| `fail-on-findings` | no | `false` | Fail the workflow when findings are reported. |
| `login-url` | no | | Optional login page URL. |
| `username` | no | | Optional test-account username. |
| `password` | no | | Optional test-account password. |
| `username-selector` | no | | CSS selector for the username field. |
| `password-selector` | no | | CSS selector for the password field. |
| `submit-selector` | no | | CSS selector for the login submit control. |

## Action Outputs

| Output | Description |
| --- | --- |
| `status` | `pass`, `warning`, or `fail`. |
| `findings-count` | Number of findings. |
| `pages-visited` | Number of pages visited. |
| `clicks-tested` | Number of click attempts recorded. |
| `json-path` | JSON report path in the caller workspace. |
| `markdown-path` | Markdown report path in the caller workspace. |
| `artifact-dir` | Screenshot artifact directory. |

## Local CLI

Clone this repo, install dependencies, and run the CLI directly:

```bash
npm install
npm run audit:url -- https://example.com --max-pages 5 --max-clicks-per-page 8
```

To write the same artifact layout used by the GitHub Action:

```bash
npm run audit:url -- https://example.com \
  --max-pages 5 \
  --max-clicks-per-page 8 \
  --artifact-dir .agentic-web-app-qa/screenshots \
  --json .agentic-web-app-qa/audit.json \
  --markdown .agentic-web-app-qa/audit.md \
  --report-root "$PWD"
```

The local CLI also reads these optional environment variables:

```text
QA_LOGIN_URL
QA_USERNAME
QA_PASSWORD
QA_USERNAME_SELECTOR
QA_PASSWORD_SELECTOR
QA_SUBMIT_SELECTOR
QA_MAX_PAGES
QA_MAX_CLICKS_PER_PAGE
QA_ARTIFACT_DIR
QA_REPORT_ROOT
```

## Eve Agent Demo

This repo also contains an Eve agent version of the same capability.

```bash
cp .env.example .env.local
# add AI_GATEWAY_API_KEY to .env.local if you want to chat with the Eve agent
npm run dev
```

Then prompt the Eve TUI:

```text
Audit https://your-preview-url.vercel.app. Visit up to 5 pages and click up to 8 controls per page.
```

The Eve agent is useful for interactive demos. The GitHub Action is the easiest way for other projects to use the audit in CI.

## Optional: Vercel Connect for GitHub

The Eve agent can publish or update a pull request report through Vercel Connect. This lets the agent request a short-lived, scoped GitHub token at runtime instead of storing a long-lived GitHub token in environment variables.

Create and attach a GitHub connector to the Vercel project that runs this agent:

```bash
vercel link
vercel connect create github --name agentic-web-qa-github
vercel connect attach github/agentic-web-qa-github --environment production
vercel connect attach github/agentic-web-qa-github --environment preview
vercel connect attach github/agentic-web-qa-github --environment development
```

Save the connector UID in the project environment:

```bash
printf 'github/agentic-web-qa-github' | vercel env add GITHUB_CONNECTOR
vercel env pull .env.local
```

If the connector has access to multiple GitHub installations, also set:

```text
GITHUB_CONNECT_INSTALLATION_ID=inst_...
```

The `publish_github_pr_report` Eve tool requests only the GitHub permissions it needs:

```text
contents:read
pull_requests:read
issues:write
```

Then you can prompt the Eve agent:

```text
Audit https://your-preview-url.vercel.app and publish the report to scottschindler/my-app PR #123.
```

Vercel Connect handles GitHub credentials. It does not replace the browser runner or deployment trigger by itself. Use the GitHub Action, a Vercel webhook, or a future Checks API integration to start the audit after a preview deployment is ready.

## How It Works

The core audit engine is in `agent/lib/web_qa.ts`.

1. Launches headless Chromium with Playwright.
2. Optionally logs in using selectors and a test account.
3. Navigates the target URL.
4. Discovers visible anchors, buttons, submit buttons, and `[role="button"]` elements.
5. Queues same-origin links up to `max-pages`.
6. Clicks visible non-link controls up to `max-clicks-per-page`.
7. Skips destructive-looking controls by label.
8. Records console errors, page errors, network failures, navigation failures, blank pages, and click failures.
9. Saves screenshots under the artifact directory.
10. Writes Markdown and JSON reports.
11. Optionally publishes the Markdown report to a GitHub PR with a Vercel Connect GitHub token.

## Current Limits

- It is a bounded smoke audit, not exhaustive UI coverage.
- It does not understand app-specific business rules.
- It avoids obvious destructive controls by label, but you should still use low-permission test accounts.
- It currently clicks one page/control at a time; deeper stateful flows are future work.
- Vercel Connect support publishes PR comments, but it does not yet provide a full Vercel-native deployment check.
- It does not yet create GitHub issues or Linear tickets automatically.

## Development

```bash
npm install
npm run typecheck
npm run smoke
```

The smoke test serves `fixtures/buggy-app` and verifies that the audit finds intentional fixture bugs. CI runs the same typecheck and smoke test on pull requests.

## License

MIT
