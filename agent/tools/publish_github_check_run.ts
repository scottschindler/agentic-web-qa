import { defineTool } from "eve/tools";
import { z } from "zod";

import { getGitHubConnectToken, githubRequest } from "../lib/github_connect.js";

type CheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "success"
  | "timed_out";

interface GitHubCheckRun {
  readonly id: number;
  readonly html_url?: string;
  readonly details_url?: string;
  readonly conclusion?: CheckConclusion;
  readonly external_id?: string;
}

interface GitHubCheckRunList {
  readonly total_count: number;
  readonly check_runs: readonly GitHubCheckRun[];
}

const defaultCheckName = "Agentic Web App QA";
const maxCheckTextLength = 65_000;

export default defineTool({
  description:
    "Create or update a GitHub Check Run for an Agentic Web QA audit using a Vercel Connect GitHub connector.",
  inputSchema: z.object({
    owner: z.string().min(1).describe("GitHub repository owner or organization."),
    repo: z.string().min(1).describe("GitHub repository name."),
    headSha: z.string().min(7).describe("Commit SHA that the check run should attach to."),
    reportMarkdown: z.string().min(1).describe("Markdown audit report to include in the check output."),
    auditStatus: z
      .enum(["pass", "warning", "fail"])
      .optional()
      .describe("Audit status. Maps to success, neutral, or failure when conclusion is not provided."),
    conclusion: z
      .enum(["action_required", "cancelled", "failure", "neutral", "skipped", "success", "timed_out"])
      .optional()
      .describe("Optional explicit GitHub check conclusion."),
    name: z.string().optional().describe("Check run name. Defaults to Agentic Web App QA."),
    title: z.string().optional().describe("Check output title."),
    summary: z.string().optional().describe("Short check output summary."),
    detailsUrl: z.string().url().optional().describe("Optional URL for deeper audit details."),
    externalId: z
      .string()
      .optional()
      .describe("Optional stable id, such as a Vercel deployment id, used to update an existing check."),
    connector: z
      .string()
      .optional()
      .describe("Optional Vercel Connect connector UID. Defaults to GITHUB_CONNECTOR."),
    installationId: z
      .string()
      .optional()
      .describe("Optional GitHub installation id when the connector has multiple installations."),
  }),
  async execute(input) {
    const owner = input.owner.trim();
    const repo = input.repo.trim();
    const repository = `${owner}/${repo}`;
    const headSha = input.headSha.trim();
    const name = input.name?.trim() || defaultCheckName;
    const conclusion = input.conclusion ?? conclusionFromAuditStatus(input.auditStatus);
    const token = await getGitHubConnectToken({
      connector: input.connector,
      installationId: input.installationId,
      repository,
      permissions: ["checks:read", "checks:write", "contents:read"],
    });
    const output = {
      title: input.title?.trim() || `${name}: ${conclusion}`,
      summary: input.summary?.trim() || summaryFromConclusion(conclusion),
      text: truncateCheckText(input.reportMarkdown.trim()),
    };
    const updateBody = {
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      details_url: input.detailsUrl,
      external_id: input.externalId,
      output,
    };
    const createBody = {
      name,
      head_sha: headSha,
      ...updateBody,
    };
    const existingCheck = input.externalId
      ? await findExistingCheckRun(token, owner, repo, headSha, name, input.externalId)
      : undefined;

    if (existingCheck) {
      const updated = await githubRequest<GitHubCheckRun>(
        token,
        "PATCH",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${existingCheck.id}`,
        updateBody,
      );

      return {
        status: "updated",
        repository,
        headSha,
        checkRunId: updated.id,
        checkRunUrl: updated.html_url,
        detailsUrl: updated.details_url,
        conclusion: updated.conclusion ?? conclusion,
      };
    }

    const created = await githubRequest<GitHubCheckRun>(
      token,
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
      createBody,
    );

    return {
      status: "created",
      repository,
      headSha,
      checkRunId: created.id,
      checkRunUrl: created.html_url,
      detailsUrl: created.details_url,
      conclusion: created.conclusion ?? conclusion,
    };
  },
});

async function findExistingCheckRun(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  name: string,
  externalId: string,
): Promise<GitHubCheckRun | undefined> {
  const query = new URLSearchParams({
    check_name: name,
    per_page: "100",
  });
  const response = await githubRequest<GitHubCheckRunList>(
    token,
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?${query.toString()}`,
  );

  return response.check_runs.find((checkRun) => checkRun.external_id === externalId);
}

function conclusionFromAuditStatus(status: "pass" | "warning" | "fail" | undefined): CheckConclusion {
  if (status === "pass") return "success";
  if (status === "fail") return "failure";
  return "neutral";
}

function summaryFromConclusion(conclusion: CheckConclusion): string {
  if (conclusion === "success") return "No blocking issues found by the bounded browser audit.";
  if (conclusion === "failure") return "The bounded browser audit found high-priority issues.";
  return "The bounded browser audit completed with non-blocking findings or no explicit status.";
}

function truncateCheckText(text: string): string {
  if (text.length <= maxCheckTextLength) return text;
  return `${text.slice(0, maxCheckTextLength - 120)}\n\n_Report truncated to fit GitHub Check Run output limits._`;
}
