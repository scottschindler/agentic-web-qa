import type { ToolContext } from "eve/tools";

import type { WebAppAuditInput, WebAppAuditResult } from "./web_qa.js";

type EveSandboxSession = Awaited<ReturnType<ToolContext["getSandbox"]>>;

export interface SandboxWebAppAuditResult extends WebAppAuditResult {
  readonly runner: "eve-sandbox";
  readonly sandboxId: string;
  readonly reportMarkdown: string;
  readonly reportPath: string;
  readonly jsonPath: string;
  readonly screenshots: readonly SandboxScreenshotArtifact[];
}

export interface SandboxScreenshotArtifact {
  readonly path: string;
  readonly fileName: string;
  readonly mediaType: "image/png";
}

interface SandboxCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runnerDirectory = "browser-audit";
const inputPath = `${runnerDirectory}/input.json`;
const jsonPath = `${runnerDirectory}/out/result.json`;
const markdownPath = `${runnerDirectory}/out/report.md`;

export async function runWebAppAuditInSandbox(
  input: WebAppAuditInput,
  ctx: ToolContext,
): Promise<SandboxWebAppAuditResult> {
  const sandbox = await ctx.getSandbox();
  const normalizedInput = {
    ...input,
    vercelAutomationBypassSecret:
      input.vercelAutomationBypassSecret ?? process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  };

  await ensureRunnerDependencies(ctx, runnerDirectory);
  await sandbox.writeTextFile({
    path: inputPath,
    content: `${JSON.stringify(normalizedInput, null, 2)}\n`,
  });

  await runChecked(
    ctx,
    [
      `cd ${shellQuote(runnerDirectory)}`,
      "rm -rf out",
      "mkdir -p out",
      `node audit-runner.mjs input.json out/result.json out/report.md`,
    ].join(" && "),
  );

  const rawResult = await readRequiredTextFile(sandbox, jsonPath);
  const reportMarkdown = await readRequiredTextFile(sandbox, markdownPath);
  const result = JSON.parse(rawResult) as WebAppAuditResult;

  return {
    ...result,
    runner: "eve-sandbox",
    sandboxId: sandbox.id,
    reportMarkdown,
    reportPath: sandbox.resolvePath(markdownPath),
    jsonPath: sandbox.resolvePath(jsonPath),
    screenshots: result.findings
      .flatMap((finding) => (finding.screenshot ? [finding.screenshot] : []))
      .map((screenshotPath) => ({
        path: screenshotPath,
        fileName: screenshotPath.split("/").at(-1) ?? "screenshot.png",
        mediaType: "image/png" as const,
      })),
  };
}

async function readRequiredTextFile(sandbox: EveSandboxSession, path: string): Promise<string> {
  const content = await sandbox.readTextFile({ path });
  if (content === null) {
    throw new Error(`Expected sandbox file to exist: ${path}`);
  }

  return content;
}

async function ensureRunnerDependencies(ctx: ToolContext, workingDirectory: string): Promise<void> {
  const result = await ctx.getSandbox().then((sandbox) =>
    sandbox.run({
      command: [
        `cd ${shellQuote(workingDirectory)}`,
        "if [ ! -f .setup-complete ]; then",
        "npm install --silent --no-audit --no-fund",
        "&& (npx playwright install --with-deps chromium || npx playwright install chromium)",
        "&& touch .setup-complete",
        "fi",
      ].join(" "),
    }),
  );

  assertCommandSucceeded("Install sandbox browser dependencies", result);
}

async function runChecked(ctx: ToolContext, command: string): Promise<SandboxCommandResult> {
  const result = await ctx.getSandbox().then((sandbox) => sandbox.run({ command }));
  assertCommandSucceeded(command, result);
  return result;
}

function assertCommandSucceeded(label: string, result: SandboxCommandResult): void {
  if (result.exitCode === 0) return;

  throw new Error(
    [
      `${label} failed with exit code ${result.exitCode}.`,
      result.stdout ? `stdout:\n${result.stdout}` : undefined,
      result.stderr ? `stderr:\n${result.stderr}` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
