# Agentic Web App QA

Agentic Web App QA is an Eve browser agent that audits Vercel preview deployments with Playwright, Vercel Sandbox, durable Eve tasks, optional native Vercel Checks, and short-lived GitHub tokens from Vercel Connect.

Give it a preview URL. Eve starts a durable audit task, runs one orchestration tool, launches Chromium inside a sandbox, optionally logs in with a test account, crawls a bounded set of same-origin pages, clicks safe visible controls, records browser/runtime failures, saves screenshots, writes Markdown plus JSON reports, and can publish a native Vercel Deployment Check, a GitHub commit check, and one sticky PR report.

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

## Vercel-Native Preview Audits

This is the main agent flow:

```text
Vercel Preview Deployment ready
-> Vercel webhook starts the Eve agent
-> Eve durable task checkpoints the audit
-> audit_vercel_preview_deployment orchestrates the pipeline
-> audit_web_app logic runs Playwright in Vercel Sandbox
-> Eve summarizes JSON, Markdown, and screenshot artifact paths
-> Eve optionally updates a native Vercel Deployment Check
-> Vercel Connect gets a scoped GitHub token
-> Eve posts or updates a GitHub Check Run and PR comment
```

### 1. Deploy the Eve agent

```bash
npm install
cp .env.example .env.local
npx eve link
npx eve deploy
```

Set these environment variables on the Vercel project that hosts the agent:

```text
AI_GATEWAY_API_KEY
AGENTIC_WEB_QA_WEBHOOK_SECRET
VERCEL_AUTOMATION_BYPASS_SECRET
VERCEL_CHECKS_OAUTH_TOKEN
GITHUB_CONNECTOR
GITHUB_CONNECT_INSTALLATION_ID
```

Notes:

- `AI_GATEWAY_API_KEY` is only needed when the project is not using Vercel OIDC for AI Gateway.
- `AGENTIC_WEB_QA_WEBHOOK_SECRET` should match the secret Vercel shows after creating the webhook. The channel verifies Vercel's `x-vercel-signature` header with this value.
- `VERCEL_AUTOMATION_BYPASS_SECRET` is only needed when the preview app has Vercel Deployment Protection enabled.
- `VERCEL_CHECKS_OAUTH_TOKEN` is optional and must be a Vercel Checks OAuth2 integration token. Without it, the native Vercel check tool returns `skipped` and the agent continues to GitHub publishing.
- `GITHUB_CONNECT_INSTALLATION_ID` is only needed when the GitHub connector has multiple installations.

### 2. Connect GitHub through Vercel Connect

Create and attach a GitHub connector to the Vercel project that runs this agent:

```bash
vercel connect create github --name agentic-web-qa-github
vercel connect attach github/agentic-web-qa-github --environment production
vercel connect attach github/agentic-web-qa-github --environment preview
vercel connect attach github/agentic-web-qa-github --environment development
```

Save the connector UID:

```bash
printf 'github/agentic-web-qa-github' | vercel env add GITHUB_CONNECTOR
```

The agent requests only these GitHub permissions at runtime:

```text
contents:read
pull_requests:read
checks:read
checks:write
issues:write
```

### 3. Add a Vercel deployment webhook

In the Vercel dashboard for the app you want to audit, create a webhook for preview deployment-ready events and point it at the deployed Eve agent:

```text
https://<agent-project>.vercel.app/eve/v1/vercel/deployment
```

Use the `deployment.ready` event. The channel also accepts `deployment.succeeded`, but `deployment.ready` is the normal trigger for auditing a fresh preview URL. The webhook channel ignores production deployments unless `AGENTIC_WEB_QA_AUDIT_PRODUCTION=true`.

After Vercel creates the webhook, copy the displayed webhook secret into the agent project's `AGENTIC_WEB_QA_WEBHOOK_SECRET` environment variable. For manual smoke tests, the same secret can be passed as `Authorization: Bearer <secret>`, `x-agentic-web-qa-secret`, or `?secret=<secret>`.

The webhook extracts the deployment URL, target, deployment id, GitHub repo, and commit SHA from Vercel metadata. Eve first tries to publish a native Vercel Deployment Check when `VERCEL_CHECKS_OAUTH_TOKEN` is configured. If GitHub metadata is present, Eve also publishes a completed GitHub Check Run for the commit, resolves the associated PR, and posts the report as a sticky comment when a PR exists. If metadata is missing, the agent still finishes the audit and returns the report.

## Optional: GitHub Action

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
VERCEL_AUTOMATION_BYPASS_SECRET
```

## Eve Agent Demo

This repo also contains an interactive Eve agent version of the same capability.

```bash
cp .env.example .env.local
# add AI_GATEWAY_API_KEY to .env.local if you want to chat with the Eve agent
npm run dev
```

Then prompt the Eve TUI:

```text
Audit https://your-preview-url.vercel.app. Visit up to 5 pages and click up to 8 controls per page.
```

The Eve agent is useful for interactive demos and for the Vercel-native webhook flow. The GitHub Action is kept as an optional CI packaging path for projects that do not want to deploy the agent.

## Manual PR Publishing

The Eve agent can also publish or update a pull request report manually through Vercel Connect. This lets the agent request a short-lived, scoped GitHub token at runtime instead of storing a long-lived GitHub token in environment variables.

Then you can prompt the Eve agent:

```text
Audit https://your-preview-url.vercel.app and publish the report to scottschindler/my-app PR #123.
```

Vercel Connect handles GitHub credentials. It does not replace the browser runner or deployment trigger by itself. In the Vercel-native flow, the Vercel webhook starts the Eve task and Connect only supplies the scoped GitHub token used to create the GitHub check run, resolve the PR, and comment on the PR. Native Vercel Checks use `VERCEL_CHECKS_OAUTH_TOKEN` because the Vercel Checks API requires an OAuth2 integration token.

## How It Works

The direct CLI/action audit engine is in `agent/lib/web_qa.ts`. The hosted Eve webhook path enters through `audit_vercel_preview_deployment`, which uses `agent/lib/sandbox_web_qa.ts` to start a sandbox session and run the browser runner seeded under `agent/sandbox/workspace/browser-audit`.

1. `agent/channels/vercel.ts` accepts Vercel deployment webhooks at `/eve/v1/vercel/deployment`.
2. The channel verifies Vercel's `x-vercel-signature` when `AGENTIC_WEB_QA_WEBHOOK_SECRET` is set, ignores non-ready events, and skips production by default.
3. The channel starts a durable Eve task with the deployment URL and GitHub metadata.
4. The task calls `audit_vercel_preview_deployment`, the single orchestration tool for webhook-triggered audits.
5. The orchestration tool calls `ctx.getSandbox()` and runs the Playwright audit in the Eve sandbox.
6. On Vercel, `agent/sandbox/sandbox.ts` selects Vercel Sandbox. Locally, it uses the existing `just-bash` fallback.
7. The sandbox runner installs Playwright, launches Chromium, crawls same-origin pages, clicks safe controls, and records console/page/network failures.
8. The runner writes JSON, Markdown, and screenshot artifacts inside the sandbox workspace.
9. `publish_vercel_deployment_check` creates or updates a native Vercel Deployment Check when a Vercel Checks OAuth token is configured. Otherwise it returns `skipped`.
10. If repo and commit metadata are present, `publish_github_check_run` asks Vercel Connect for a scoped GitHub token with check permissions and creates or updates a completed check run for the commit.
11. `resolve_github_pull_request` asks Vercel Connect for a scoped GitHub token and finds the associated PR.
12. `publish_github_pr_report` asks Connect for a scoped token with comment permissions and creates or updates one sticky PR report when a PR is available.
13. Eve summarizes the audit and publication results for the webhook task.

## Current Limits

- It is a bounded smoke audit, not exhaustive UI coverage.
- It does not understand app-specific business rules.
- It avoids obvious destructive controls by label, but you should still use low-permission test accounts.
- It currently clicks one page/control at a time; deeper stateful flows are future work.
- Native Vercel Deployment Checks require a Vercel Checks OAuth2 integration token. Without that token, the tool skips and the agent still publishes GitHub checks/comments when configured.
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
