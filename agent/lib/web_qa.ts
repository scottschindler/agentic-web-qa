import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

export interface WebAppAuditInput {
  readonly url: string;
  readonly loginUrl?: string;
  readonly username?: string;
  readonly password?: string;
  readonly usernameSelector?: string;
  readonly passwordSelector?: string;
  readonly submitSelector?: string;
  readonly maxPages?: number;
  readonly maxClicksPerPage?: number;
  readonly artifactDir?: string;
}

export type FindingSeverity = "low" | "medium" | "high";

export interface WebAppAuditFinding {
  readonly severity: FindingSeverity;
  readonly type:
    | "blank-page"
    | "click-failed"
    | "console-error"
    | "login-failed"
    | "navigation-error"
    | "network-failure"
    | "page-error";
  readonly message: string;
  readonly url: string;
  readonly screenshot?: string;
}

export interface ClickRecord {
  readonly pageUrl: string;
  readonly label: string;
  readonly tag: string;
  readonly result: "clicked" | "failed" | "skipped";
  readonly reason?: string;
  readonly finalUrl?: string;
}

export interface WebAppAuditResult {
  readonly targetUrl: string;
  readonly status: "pass" | "warning" | "fail";
  readonly summary: string;
  readonly pagesVisited: readonly string[];
  readonly clicksTested: readonly ClickRecord[];
  readonly findings: readonly WebAppAuditFinding[];
  readonly artifactDir: string;
}

interface Candidate {
  readonly id: string;
  readonly tag: string;
  readonly label: string;
  readonly href?: string;
  readonly destructive: boolean;
}

const destructivePattern =
  /\b(delete|remove|destroy|refund|charge|pay|purchase|send|publish|archive|logout|log out|sign out|cancel subscription)\b/i;

const defaultMaxPages = 5;
const defaultMaxClicksPerPage = 8;

export async function runWebAppAudit(input: WebAppAuditInput): Promise<WebAppAuditResult> {
  const targetUrl = normalizeUrl(input.url);
  const maxPages = clamp(input.maxPages ?? defaultMaxPages, 1, 20);
  const maxClicksPerPage = clamp(input.maxClicksPerPage ?? defaultMaxClicksPerPage, 0, 30);
  const artifactDir = await createArtifactDir(targetUrl, input.artifactDir);
  const findings: WebAppAuditFinding[] = [];
  const clicksTested: ClickRecord[] = [];
  const pagesVisited: string[] = [];
  const queued = [targetUrl];
  const seen = new Set<string>();

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
    });
    const page = await context.newPage();
    attachFailureListeners(page, findings, artifactDir);

    if (shouldAttemptLogin(input)) {
      await login(page, input, findings, artifactDir);
    }

    while (queued.length > 0 && pagesVisited.length < maxPages) {
      const currentUrl = queued.shift()!;
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

function shouldAttemptLogin(input: WebAppAuditInput): boolean {
  return Boolean(
    input.loginUrl &&
      input.username &&
      input.password &&
      input.usernameSelector &&
      input.passwordSelector,
  );
}

async function login(
  page: Page,
  input: WebAppAuditInput,
  findings: WebAppAuditFinding[],
  artifactDir: string,
): Promise<void> {
  try {
    await page.goto(input.loginUrl!, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.fill(input.usernameSelector!, input.username!, { timeout: 5000 });
    await page.fill(input.passwordSelector!, input.password!, { timeout: 5000 });

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
      url: input.loginUrl!,
      screenshot: await screenshot(page, artifactDir, "login-failed"),
    });
  }
}

async function goto(
  page: Page,
  url: string,
  findings: WebAppAuditFinding[],
  artifactDir: string,
) {
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

function attachFailureListeners(
  page: Page,
  findings: WebAppAuditFinding[],
  artifactDir: string,
): void {
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

async function detectBlankPage(
  page: Page,
  findings: WebAppAuditFinding[],
  artifactDir: string,
): Promise<void> {
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

async function discoverCandidates(page: Page): Promise<Candidate[]> {
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

async function markCandidateByLabel(page: Page, candidate: Candidate): Promise<Candidate | null> {
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

function internalLinks(candidates: readonly Candidate[], targetUrl: string): string[] {
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

async function screenshot(page: Page, artifactDir: string, label: string): Promise<string | undefined> {
  try {
    const fileName = `${Date.now()}-${label}.png`;
    const absolutePath = path.join(artifactDir, fileName);
    await page.screenshot({ fullPage: true, path: absolutePath });
    return absolutePath;
  } catch {
    return undefined;
  }
}

async function createArtifactDir(url: string, configuredDir?: string): Promise<string> {
  if (configuredDir && configuredDir.trim().length > 0) {
    const dir = path.resolve(configuredDir);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
  const dir = path.join(process.cwd(), ".eve-qa-artifacts", hash);
  await mkdir(dir, { recursive: true });
  return dir;
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function deriveStatus(findings: readonly WebAppAuditFinding[]): WebAppAuditResult["status"] {
  if (findings.some((finding) => finding.severity === "high")) return "fail";
  if (findings.length > 0) return "warning";
  return "pass";
}

function summarize(
  status: WebAppAuditResult["status"],
  pagesVisited: number,
  clicksTested: number,
  findings: number,
): string {
  if (status === "pass") {
    return `No blocking issues found across ${pagesVisited} page(s) and ${clicksTested} click attempt(s).`;
  }

  return `Found ${findings} issue(s) across ${pagesVisited} page(s) and ${clicksTested} click attempt(s).`;
}
