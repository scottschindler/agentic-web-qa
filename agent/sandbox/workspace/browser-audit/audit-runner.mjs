import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const destructivePattern =
  /\b(delete|remove|destroy|refund|charge|pay|purchase|send|publish|archive|logout|log out|sign out|cancel subscription)\b/i;

const defaultMaxPages = 5;
const defaultMaxClicksPerPage = 8;

const inputPath = process.argv[2] ?? "input.json";
const jsonPath = process.argv[3] ?? "out/result.json";
const markdownPath = process.argv[4] ?? "out/report.md";

const input = JSON.parse(await readFile(inputPath, "utf8"));
const result = await runWebAppAudit(input);

await mkdir(path.dirname(path.resolve(jsonPath)), { recursive: true });
await mkdir(path.dirname(path.resolve(markdownPath)), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
await writeFile(markdownPath, formatMarkdown(result));

async function runWebAppAudit(rawInput) {
  const targetUrl = normalizeUrl(rawInput.url);
  const maxPages = clamp(rawInput.maxPages ?? defaultMaxPages, 1, 20);
  const maxClicksPerPage = clamp(rawInput.maxClicksPerPage ?? defaultMaxClicksPerPage, 0, 30);
  const artifactDir = await createArtifactDir(targetUrl, rawInput.artifactDir);
  const findings = [];
  const clicksTested = [];
  const pagesVisited = [];
  const queued = [targetUrl];
  const seen = new Set();

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const extraHTTPHeaders = buildExtraHTTPHeaders(rawInput);
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}),
    });
    const page = await context.newPage();
    attachFailureListeners(page, findings, artifactDir);

    if (shouldAttemptLogin(rawInput)) {
      await login(page, rawInput, findings, artifactDir);
    }

    while (queued.length > 0 && pagesVisited.length < maxPages) {
      const currentUrl = queued.shift();
      if (seen.has(currentUrl)) continue;
      seen.add(currentUrl);

      const response = await goto(page, currentUrl, findings, artifactDir);
      pagesVisited.push(page.url());

      if (response !== null && response.status() >= 400) {
        findings.push({
          severity: response.status() >= 500 ? "high" : "medium",
          type: "navigation-error",
          message: `Navigation returned HTTP ${response.status()}.`,
          url: currentUrl,
          screenshot: await screenshot(page, artifactDir, "navigation-error"),
        });
      }

      await detectBlankPage(page, findings, artifactDir);

      const candidates = await discoverCandidates(page);
      for (const href of internalLinks(candidates, targetUrl)) {
        if (!seen.has(href) && !queued.includes(href) && pagesVisited.length + queued.length < maxPages) {
          queued.push(href);
        }
      }

      const clickableCandidates = candidates
        .filter((candidate) => candidate.href === undefined)
        .slice(0, maxClicksPerPage);

      for (const candidate of clickableCandidates) {
        if (candidate.destructive) {
          clicksTested.push({
            pageUrl: currentUrl,
            label: candidate.label,
            tag: candidate.tag,
            result: "skipped",
            reason: "Label looked destructive.",
          });
          continue;
        }

        await goto(page, currentUrl, findings, artifactDir);
        const freshCandidate = await markCandidateByLabel(page, candidate);
        if (freshCandidate === null) {
          clicksTested.push({
            pageUrl: currentUrl,
            label: candidate.label,
            tag: candidate.tag,
            result: "failed",
            reason: "The control was not found after page reload.",
          });
          continue;
        }

        try {
          await page.locator(`[data-eve-qa-id="${freshCandidate.id}"]`).click({ timeout: 3000 });
          await page.waitForLoadState("domcontentloaded", { timeout: 2500 }).catch(() => undefined);
          clicksTested.push({
            pageUrl: currentUrl,
            label: freshCandidate.label,
            tag: freshCandidate.tag,
            result: "clicked",
            finalUrl: page.url(),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const shot = await screenshot(page, artifactDir, "click-failed");
          clicksTested.push({
            pageUrl: currentUrl,
            label: freshCandidate.label,
            tag: freshCandidate.tag,
            result: "failed",
            reason: message,
          });
          findings.push({
            severity: "medium",
            type: "click-failed",
            message: `Click failed for "${freshCandidate.label}": ${message}`,
            url: currentUrl,
            screenshot: shot,
          });
        }
      }
    }
  } finally {
    await browser?.close();
  }

  const status = deriveStatus(findings);
  return {
    targetUrl,
    status,
    summary: summarize(status, pagesVisited.length, clicksTested.length, findings.length),
    pagesVisited,
    clicksTested,
    findings,
    artifactDir,
  };
}

function shouldAttemptLogin(input) {
  return Boolean(
    input.loginUrl &&
      input.username &&
      input.password &&
      input.usernameSelector &&
      input.passwordSelector,
  );
}

async function login(page, input, findings, artifactDir) {
  try {
    await page.goto(input.loginUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.fill(input.usernameSelector, input.username, { timeout: 5000 });
    await page.fill(input.passwordSelector, input.password, { timeout: 5000 });

    if (input.submitSelector) {
      await page.click(input.submitSelector, { timeout: 5000 });
    } else {
      await page.keyboard.press("Enter");
    }

    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({
      severity: "high",
      type: "login-failed",
      message: `Login flow failed: ${message}`,
      url: input.loginUrl,
      screenshot: await screenshot(page, artifactDir, "login-failed"),
    });
  }
}

async function goto(page, url, findings, artifactDir) {
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({
      severity: "high",
      type: "navigation-error",
      message: `Navigation failed: ${message}`,
      url,
      screenshot: await screenshot(page, artifactDir, "navigation-failed"),
    });
    return null;
  }
}

function attachFailureListeners(page, findings, artifactDir) {
  page.on("console", async (message) => {
    if (message.type() !== "error") return;
    findings.push({
      severity: "medium",
      type: "console-error",
      message: message.text(),
      url: page.url(),
      screenshot: await screenshot(page, artifactDir, "console-error"),
    });
  });

  page.on("pageerror", async (error) => {
    findings.push({
      severity: "high",
      type: "page-error",
      message: error.message,
      url: page.url(),
      screenshot: await screenshot(page, artifactDir, "page-error"),
    });
  });

  page.on("requestfailed", (request) => {
    findings.push({
      severity: "medium",
      type: "network-failure",
      message: `${request.method()} ${request.url()} failed: ${request.failure()?.errorText ?? "unknown error"}`,
      url: page.url(),
    });
  });
}

async function detectBlankPage(page, findings, artifactDir) {
  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  const interactiveCount = await page
    .locator('a, button, input, select, textarea, [role="button"]')
    .count()
    .catch(() => 0);

  if (bodyText.trim().length === 0 && interactiveCount === 0) {
    findings.push({
      severity: "high",
      type: "blank-page",
      message: "Page body is blank and no interactive controls were found.",
      url: page.url(),
      screenshot: await screenshot(page, artifactDir, "blank-page"),
    });
  }
}

async function discoverCandidates(page) {
  const script = `(() => {
      const destructive = new RegExp(${JSON.stringify(destructivePattern.source)}, "i");
      const nodes = Array.from(
        document.querySelectorAll(
          'a[href], button, input[type="button"], input[type="submit"], [role="button"]'
        )
      );

      const labelFor = element => {
        return (
          element.innerText ||
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.value ||
          element.getAttribute("href") ||
          element.tagName.toLowerCase()
        ).trim();
      };

      return nodes
        .filter(element => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            !element.hasAttribute("disabled")
          );
        })
        .slice(0, 100)
        .map((element, index) => {
          const label = labelFor(element);
          const id = "eve-qa-" + index;
          element.setAttribute("data-eve-qa-id", id);
          return {
            id,
            tag: element.tagName.toLowerCase(),
            label,
            href: element instanceof HTMLAnchorElement ? element.href : undefined,
            destructive: destructive.test(label),
          };
        });
    })()`;

  return page.evaluate(script);
}

async function markCandidateByLabel(page, candidate) {
  const candidates = await discoverCandidates(page);
  return (
    candidates.find(
      (item) =>
        item.label === candidate.label &&
        item.tag === candidate.tag &&
        item.destructive === candidate.destructive,
    ) ?? null
  );
}

function internalLinks(candidates, targetUrl) {
  const origin = new URL(targetUrl).origin;
  return candidates.flatMap((candidate) => {
    if (!candidate.href) return [];
    try {
      const parsed = new URL(candidate.href);
      if (parsed.origin !== origin) return [];
      parsed.hash = "";
      return [parsed.toString()];
    } catch {
      return [];
    }
  });
}

async function screenshot(page, artifactDir, label) {
  try {
    const fileName = `${Date.now()}-${label}.png`;
    const absolutePath = path.join(artifactDir, fileName);
    await page.screenshot({ fullPage: true, path: absolutePath });
    return absolutePath;
  } catch {
    return undefined;
  }
}

async function createArtifactDir(url, configuredDir) {
  if (configuredDir && configuredDir.trim().length > 0) {
    const dir = path.resolve(configuredDir);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
  const dir = path.join(process.cwd(), "artifacts", hash);
  await mkdir(dir, { recursive: true });
  return dir;
}

function buildExtraHTTPHeaders(input) {
  if (!input.vercelAutomationBypassSecret) return undefined;

  return {
    "x-vercel-protection-bypass": input.vercelAutomationBypassSecret,
    "x-vercel-set-bypass-cookie": "true",
  };
}

function normalizeUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function deriveStatus(findings) {
  if (findings.some((finding) => finding.severity === "high")) return "fail";
  if (findings.length > 0) return "warning";
  return "pass";
}

function summarize(status, pagesVisited, clicksTested, findings) {
  if (status === "pass") {
    return `No blocking issues found across ${pagesVisited} page(s) and ${clicksTested} click attempt(s).`;
  }

  return `Found ${findings} issue(s) across ${pagesVisited} page(s) and ${clicksTested} click attempt(s).`;
}

function formatMarkdown(result) {
  const lines = [];

  lines.push("## Agentic Web App QA");
  lines.push("");
  lines.push(`**Status:** ${result.status.toUpperCase()}`);
  lines.push("");
  lines.push(result.summary);
  lines.push("");
  lines.push(`- Target: ${result.targetUrl}`);
  lines.push(`- Pages visited: ${result.pagesVisited.length}`);
  lines.push(`- Click attempts: ${result.clicksTested.length}`);
  lines.push(`- Findings: ${result.findings.length}`);
  lines.push(`- Sandbox artifact directory: \`${result.artifactDir}\``);

  lines.push("");
  lines.push("### Findings");
  lines.push("");
  if (result.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of result.findings) {
      lines.push(
        `- **${finding.severity.toUpperCase()} / ${finding.type}** on ${finding.url}: ${finding.message}`,
      );
      if (finding.screenshot) {
        lines.push(`  - Screenshot artifact: \`${finding.screenshot}\``);
      }
    }
  }

  lines.push("");
  lines.push("### Pages Visited");
  lines.push("");
  for (const page of result.pagesVisited) {
    lines.push(`- ${page}`);
  }

  lines.push("");
  lines.push("### Clicks Tested");
  lines.push("");
  if (result.clicksTested.length === 0) {
    lines.push("No click attempts.");
  } else {
    for (const click of result.clicksTested) {
      const suffix = click.reason ? ` - ${click.reason}` : "";
      lines.push(`- ${click.result}: "${click.label}" (${click.tag}) on ${click.pageUrl}${suffix}`);
    }
  }

  lines.push("");
  lines.push(
    "_This is a bounded smoke audit. It checks same-origin navigation, safe visible controls, console/page/network failures, and screenshots. It is not exhaustive UI proof yet._",
  );
  lines.push("");

  return `${lines.join("\n")}\n`;
}
