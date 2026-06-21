---
description: Use when auditing a web app, preview deployment, login flow, forms, buttons, or UI regressions.
---

For a first-pass web app QA run:

1. Confirm the target URL and whether login is required.
2. Use a non-production test account.
3. Prefer safe interactions: navigation, opening panels, toggles, filters, search, and non-destructive form validation.
4. Skip controls whose label implies deletion, payment, refunds, account changes, publication, logout, or irreversible side effects unless the user approves that exact action.
5. Treat these as bugs: console errors, page errors, failed network requests, 4xx/5xx navigations, blank screens, broken links, and clicks that throw or detach unexpectedly.
6. Return a ranked report with reproduction notes and screenshots where available.
