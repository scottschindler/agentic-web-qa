import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WebAppAuditResult } from "../agent/lib/web_qa.js";
import { runWebAppAudit, type WebAppAuditInput } from "../agent/lib/web_qa.js";

interface CliOptions {
  readonly input: WebAppAuditInput;
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly githubOutputPath?: string;
  readonly githubSummaryPath?: string;
  readonly reportRootPath: string;
}

const options = parseArgs(process.argv.slice(2));
const result = await runWebAppAudit(options.input);
const markdown = formatMarkdown(result, options.reportRootPath);

await mkdir(path.dirname(options.jsonPath), { recursive: true });
await mkdir(path.dirname(options.markdownPath), { recursive: true });
await writeFile(options.jsonPath, `${JSON.stringify(result, null, 2)}\n`);
await writeFile(options.markdownPath, markdown);
await writeGithubOutput(options.githubOutputPath, result, options);
await appendGithubSummary(options.githubSummaryPath, markdown);

console.log(markdown);
console.log(`\nJSON report: ${options.jsonPath}`);
console.log(`Markdown report: ${options.markdownPath}`);

function parseArgs(args: readonly string[]): CliOptions {
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    flags.set(key, value);
    index += 1;
  }

  const url = positional[0] ?? flags.get("url");
  if (!url) {
    throw new Error(
      "Usage: npm run audit:url -- <url> [--max-pages 5] [--max-clicks-per-page 8] [--artifact-dir .agentic-web-app-qa/screenshots]",
    );
  }

  const input: WebAppAuditInput = {
    url,
    loginUrl: flags.get("login-url") ?? process.env.QA_LOGIN_URL,
    username: flags.get("username") ?? process.env.QA_USERNAME,
    password: flags.get("password") ?? process.env.QA_PASSWORD,
    usernameSelector: flags.get("username-selector") ?? process.env.QA_USERNAME_SELECTOR,
    passwordSelector: flags.get("password-selector") ?? process.env.QA_PASSWORD_SELECTOR,
    submitSelector: flags.get("submit-selector") ?? process.env.QA_SUBMIT_SELECTOR,
    maxPages: parseOptionalInt(flags.get("max-pages") ?? process.env.QA_MAX_PAGES),
    maxClicksPerPage: parseOptionalInt(
      flags.get("max-clicks-per-page") ?? process.env.QA_MAX_CLICKS_PER_PAGE,
    ),
    artifactDir: flags.get("artifact-dir") ?? process.env.QA_ARTIFACT_DIR,
    vercelAutomationBypassSecret:
      flags.get("vercel-automation-bypass-secret") ?? process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  };

  return {
    input,
    jsonPath: flags.get("json") ?? ".eve-qa-artifacts/latest/audit.json",
    markdownPath: flags.get("markdown") ?? ".eve-qa-artifacts/latest/audit.md",
    githubOutputPath: flags.get("github-output") ?? process.env.GITHUB_OUTPUT,
    githubSummaryPath: flags.get("github-summary") ?? process.env.GITHUB_STEP_SUMMARY,
    reportRootPath:
      flags.get("report-root") ?? process.env.QA_REPORT_ROOT ?? process.env.GITHUB_WORKSPACE ?? process.cwd(),
  };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Expected an integer, got ${value}`);
  return parsed;
}

function formatMarkdown(result: WebAppAuditResult, reportRootPath: string): string {
  const lines: string[] = [];

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
  lines.push(`- Artifact directory: \`${relativePath(result.artifactDir, reportRootPath)}\``);

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
        lines.push(`  - Screenshot artifact: \`${relativePath(finding.screenshot, reportRootPath)}\``);
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

function relativePath(absolutePath: string, rootPath: string): string {
  const relative = path.relative(path.resolve(rootPath), absolutePath);
  return relative.startsWith("..") ? absolutePath : relative;
}

async function writeGithubOutput(
  outputPath: string | undefined,
  result: WebAppAuditResult,
  options: CliOptions,
): Promise<void> {
  if (!outputPath) return;

  const output = [
    `status=${result.status}`,
    `findings-count=${result.findings.length}`,
    `pages-visited=${result.pagesVisited.length}`,
    `clicks-tested=${result.clicksTested.length}`,
    `json-path=${options.jsonPath}`,
    `markdown-path=${options.markdownPath}`,
    `artifact-dir=${result.artifactDir}`,
  ];

  await writeFile(outputPath, `${output.join("\n")}\n`, { flag: "a" });
}

async function appendGithubSummary(summaryPath: string | undefined, markdown: string): Promise<void> {
  if (!summaryPath) return;
  await writeFile(summaryPath, markdown, { flag: "a" });
}
