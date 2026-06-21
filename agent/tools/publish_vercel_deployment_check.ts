import { defineTool } from "eve/tools";
import { z } from "zod";

type VercelCheckConclusion = "canceled" | "failed" | "neutral" | "succeeded" | "skipped";

interface VercelCheck {
  readonly id: string;
  readonly name?: string;
  readonly status?: "registered" | "running" | "completed";
  readonly conclusion?: VercelCheckConclusion | "stale";
  readonly detailsUrl?: string;
  readonly externalId?: string;
}

interface VercelCheckList {
  readonly checks?: readonly VercelCheck[];
}

const defaultCheckName = "Agentic Web App QA";
const maxOutputTextLength = 20_000;

export default defineTool({
  description:
    "Create or update a native Vercel Deployment Check for an Agentic Web QA audit. Requires a Vercel Checks OAuth token.",
  inputSchema: z.object({
    deploymentId: z.string().min(1).describe("Vercel deployment id from the webhook payload."),
    reportMarkdown: z.string().min(1).describe("Markdown audit report to include in check output."),
    auditStatus: z
      .enum(["pass", "warning", "fail"])
      .optional()
      .describe("Audit status. Maps to succeeded, neutral, or failed when conclusion is not provided."),
    conclusion: z
      .enum(["canceled", "failed", "neutral", "succeeded", "skipped"])
      .optional()
      .describe("Optional explicit Vercel check conclusion."),
    checkId: z.string().optional().describe("Existing Vercel check id to update."),
    name: z.string().optional().describe("Check name. Defaults to Agentic Web App QA."),
    summary: z.string().optional().describe("Short audit summary for the Vercel check output."),
    detailsUrl: z.string().url().optional().describe("Optional URL for deeper audit details."),
    externalId: z
      .string()
      .optional()
      .describe("Optional stable id, such as a Vercel deployment id, used to update an existing check."),
    path: z.string().optional().describe("Optional path associated with the check, such as /."),
    blocking: z
      .boolean()
      .optional()
      .describe("Whether the check can block deployment aliasing when configured as required."),
    rerequestable: z.boolean().optional().describe("Whether users can request the check to rerun."),
    token: z
      .string()
      .optional()
      .describe("Vercel Checks OAuth token. Defaults to VERCEL_CHECKS_OAUTH_TOKEN."),
    teamId: z.string().optional().describe("Optional Vercel team id. Defaults to VERCEL_TEAM_ID."),
    teamSlug: z.string().optional().describe("Optional Vercel team slug. Defaults to VERCEL_TEAM_SLUG."),
  }),
  async execute(input) {
    const token = input.token ?? process.env.VERCEL_CHECKS_OAUTH_TOKEN;
    if (!token) {
      return {
        status: "skipped",
        reason:
          "VERCEL_CHECKS_OAUTH_TOKEN is not configured. Native Vercel Checks API calls require an OAuth2 integration token.",
        deploymentId: input.deploymentId,
      };
    }

    const deploymentId = input.deploymentId.trim();
    const name = input.name?.trim() || defaultCheckName;
    const conclusion = input.conclusion ?? conclusionFromAuditStatus(input.auditStatus);
    const teamId = input.teamId ?? process.env.VERCEL_TEAM_ID;
    const teamSlug = input.teamSlug ?? process.env.VERCEL_TEAM_SLUG;
    const externalId = input.externalId ?? deploymentId;
    const existingCheck = input.checkId
      ? undefined
      : await findExistingCheck(token, deploymentId, { teamId, teamSlug }, name, externalId);
    const checkId =
      input.checkId?.trim() ||
      existingCheck?.id ||
      (
        await createCheck(token, deploymentId, { teamId, teamSlug }, {
          name,
          blocking: input.blocking ?? false,
          detailsUrl: input.detailsUrl,
          externalId,
          path: input.path,
          rerequestable: input.rerequestable ?? true,
        })
      ).id;

    const updated = await updateCheck(token, deploymentId, checkId, { teamId, teamSlug }, {
      conclusion,
      detailsUrl: input.detailsUrl,
      externalId,
      output: {
        agenticWebQa: {
          status: input.auditStatus,
          conclusion,
          summary: input.summary ?? summaryFromConclusion(conclusion),
          reportMarkdown: truncateOutputText(input.reportMarkdown.trim()),
        },
      },
    });

    return {
      status: existingCheck || input.checkId ? "updated" : "created-and-completed",
      deploymentId,
      checkId: updated.id,
      checkStatus: updated.status,
      conclusion: updated.conclusion ?? conclusion,
      detailsUrl: updated.detailsUrl,
    };
  },
});

async function findExistingCheck(
  token: string,
  deploymentId: string,
  query: VercelChecksQuery,
  name: string,
  externalId: string,
): Promise<VercelCheck | undefined> {
  const response = await vercelChecksRequest<VercelCheckList | readonly VercelCheck[]>(
    token,
    "GET",
    `/v1/deployments/${encodeURIComponent(deploymentId)}/checks`,
    query,
  );
  const checks: readonly VercelCheck[] = Array.isArray(response)
    ? (response as readonly VercelCheck[])
    : ((response as VercelCheckList).checks ?? []);
  return checks.find((check) => check.name === name && check.externalId === externalId);
}

async function createCheck(
  token: string,
  deploymentId: string,
  query: VercelChecksQuery,
  body: {
    readonly blocking: boolean;
    readonly detailsUrl?: string;
    readonly externalId?: string;
    readonly name: string;
    readonly path?: string;
    readonly rerequestable: boolean;
  },
): Promise<VercelCheck> {
  return vercelChecksRequest<VercelCheck>(
    token,
    "POST",
    `/v1/deployments/${encodeURIComponent(deploymentId)}/checks`,
    query,
    {
      ...body,
      status: "running",
    },
  );
}

async function updateCheck(
  token: string,
  deploymentId: string,
  checkId: string,
  query: VercelChecksQuery,
  body: {
    readonly conclusion: VercelCheckConclusion;
    readonly detailsUrl?: string;
    readonly externalId?: string;
    readonly output: unknown;
  },
): Promise<VercelCheck> {
  return vercelChecksRequest<VercelCheck>(
    token,
    "PATCH",
    `/v1/deployments/${encodeURIComponent(deploymentId)}/checks/${encodeURIComponent(checkId)}`,
    query,
    {
      ...body,
      status: "completed",
    },
  );
}

interface VercelChecksQuery {
  readonly teamId?: string;
  readonly teamSlug?: string;
}

async function vercelChecksRequest<T>(
  token: string,
  method: "GET" | "PATCH" | "POST",
  path: string,
  query: VercelChecksQuery,
  body?: unknown,
): Promise<T> {
  const searchParams = new URLSearchParams();
  if (query.teamId) searchParams.set("teamId", query.teamId);
  if (query.teamSlug) searchParams.set("slug", query.teamSlug);
  const search = searchParams.toString();
  const response = await fetch(`https://api.vercel.com${path}${search ? `?${search}` : ""}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vercel Checks ${method} ${path} failed with ${response.status}: ${text}`);
  }

  return (await response.json()) as T;
}

function conclusionFromAuditStatus(status: "pass" | "warning" | "fail" | undefined): VercelCheckConclusion {
  if (status === "pass") return "succeeded";
  if (status === "fail") return "failed";
  return "neutral";
}

function summaryFromConclusion(conclusion: VercelCheckConclusion): string {
  if (conclusion === "succeeded") return "No blocking issues found by the bounded browser audit.";
  if (conclusion === "failed") return "The bounded browser audit found high-priority issues.";
  return "The bounded browser audit completed with non-blocking findings or no explicit status.";
}

function truncateOutputText(text: string): string {
  if (text.length <= maxOutputTextLength) return text;
  return `${text.slice(0, maxOutputTextLength - 120)}\n\n_Report truncated to keep the Vercel check output compact._`;
}
