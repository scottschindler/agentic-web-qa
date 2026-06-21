import type { ToolContext } from "eve/tools";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { runWebAppAuditInSandbox } from "../lib/sandbox_web_qa.js";
import publishGitHubCheckRunTool from "./publish_github_check_run.js";
import publishGitHubPrReportTool from "./publish_github_pr_report.js";
import publishVercelDeploymentCheckTool from "./publish_vercel_deployment_check.js";
import resolveGitHubPullRequestTool from "./resolve_github_pull_request.js";

interface ToolLike<Input, Output> {
  execute(input: Input, ctx: ToolContext): Promise<Output> | Output;
}

interface PublicationResult {
  readonly surface: "vercel-deployment-check" | "github-check-run" | "github-pr-comment" | "github-pr-resolution";
  readonly status: "created" | "created-and-completed" | "failed" | "skipped" | "updated" | "resolved" | "not-found";
  readonly result?: unknown;
  readonly error?: string;
}

export default defineTool({
  description:
    "Run the full Vercel preview deployment audit pipeline: sandbox browser audit, native Vercel check, GitHub check run, PR resolution, and PR report comment.",
  inputSchema: z.object({
    deploymentUrl: z.string().url().describe("Ready Vercel preview deployment URL to audit."),
    deploymentId: z.string().min(1).describe("Vercel deployment id from the webhook payload."),
    eventType: z.string().optional().describe("Vercel webhook event type."),
    target: z.string().optional().describe("Vercel deployment target, such as preview or production."),
    projectName: z.string().optional().describe("Optional Vercel project name."),
    projectId: z.string().optional().describe("Optional Vercel project id."),
    owner: z.string().optional().describe("GitHub repository owner or organization from Vercel metadata."),
    repo: z.string().optional().describe("GitHub repository name from Vercel metadata."),
    commitSha: z.string().optional().describe("GitHub commit SHA from Vercel metadata."),
    loginUrl: z.string().url().optional().describe("Optional login page URL."),
    username: z.string().optional().describe("Optional test-account username."),
    password: z.string().optional().describe("Optional test-account password."),
    usernameSelector: z.string().optional().describe("CSS selector for the username field."),
    passwordSelector: z.string().optional().describe("CSS selector for the password field."),
    submitSelector: z.string().optional().describe("CSS selector for the login submit control."),
    maxPages: z.number().int().min(1).max(20).optional().describe("Maximum same-origin pages to visit."),
    maxClicksPerPage: z
      .number()
      .int()
      .min(0)
      .max(30)
      .optional()
      .describe("Maximum visible non-link controls to click on each page."),
    detailsUrl: z
      .string()
      .url()
      .optional()
      .describe("Optional details URL for check surfaces. Defaults to the deployment URL."),
    githubConnector: z
      .string()
      .optional()
      .describe("Optional Vercel Connect GitHub connector UID. Defaults to GITHUB_CONNECTOR."),
    githubInstallationId: z
      .string()
      .optional()
      .describe("Optional GitHub installation id when the connector has multiple installations."),
    vercelCheckId: z.string().optional().describe("Optional existing Vercel deployment check id to update."),
  }),
  async execute(input, ctx) {
    const audit = await runWebAppAuditInSandbox(
      {
        url: input.deploymentUrl,
        loginUrl: input.loginUrl,
        username: input.username,
        password: input.password,
        usernameSelector: input.usernameSelector,
        passwordSelector: input.passwordSelector,
        submitSelector: input.submitSelector,
        maxPages: input.maxPages,
        maxClicksPerPage: input.maxClicksPerPage,
      },
      ctx,
    );
    const detailsUrl = input.detailsUrl ?? input.deploymentUrl;
    const publications: PublicationResult[] = [];

    publications.push(
      await safePublish("vercel-deployment-check", async () => {
        const result = await asTool<
          {
            deploymentId: string;
            reportMarkdown: string;
            auditStatus: "pass" | "warning" | "fail";
            checkId?: string;
            detailsUrl: string;
            externalId: string;
            summary: string;
          },
          { status?: string }
        >(publishVercelDeploymentCheckTool).execute(
          {
            deploymentId: input.deploymentId,
            reportMarkdown: audit.reportMarkdown,
            auditStatus: audit.status,
            checkId: input.vercelCheckId,
            detailsUrl,
            externalId: input.deploymentId,
            summary: audit.summary,
          },
          ctx,
        );
        return {
          status:
            result.status === "skipped"
              ? "skipped"
              : result.status === "updated"
                ? "updated"
                : "created-and-completed",
          result,
        };
      }),
    );

    if (input.owner && input.repo && input.commitSha) {
      publications.push(
        await safePublish("github-check-run", async () => {
          const result = await asTool<
            {
              owner: string;
              repo: string;
              headSha: string;
              reportMarkdown: string;
              auditStatus: "pass" | "warning" | "fail";
              detailsUrl: string;
              externalId: string;
              summary: string;
              connector?: string;
              installationId?: string;
            },
            { status?: string }
          >(publishGitHubCheckRunTool).execute(
            {
              owner: input.owner!,
              repo: input.repo!,
              headSha: input.commitSha!,
              reportMarkdown: audit.reportMarkdown,
              auditStatus: audit.status,
              detailsUrl,
              externalId: input.deploymentId,
              summary: audit.summary,
              connector: input.githubConnector,
              installationId: input.githubInstallationId,
            },
            ctx,
          );
          return {
            status: result.status === "updated" ? "updated" : "created",
            result,
          };
        }),
      );

      const pullRequestResolution = await safePublish("github-pr-resolution", async () => {
        const result = await asTool<
          {
            owner: string;
            repo: string;
            commitSha: string;
            connector?: string;
            installationId?: string;
          },
          { found: boolean; pullRequestNumber?: number }
        >(resolveGitHubPullRequestTool).execute(
          {
            owner: input.owner!,
            repo: input.repo!,
            commitSha: input.commitSha!,
            connector: input.githubConnector,
            installationId: input.githubInstallationId,
          },
          ctx,
        );
        return {
          status: result.found ? "resolved" : "not-found",
          result,
        };
      });
      publications.push(pullRequestResolution);

      const resolvedPr = pullRequestResolution.result as
        | { found?: boolean; pullRequestNumber?: number }
        | undefined;
      if (resolvedPr?.found && resolvedPr.pullRequestNumber) {
        publications.push(
          await safePublish("github-pr-comment", async () => {
            const result = await asTool<
              {
                owner: string;
                repo: string;
                pullRequestNumber: number;
                reportMarkdown: string;
                connector?: string;
                installationId?: string;
              },
              { status?: string }
            >(publishGitHubPrReportTool).execute(
              {
                owner: input.owner!,
                repo: input.repo!,
                pullRequestNumber: resolvedPr.pullRequestNumber!,
                reportMarkdown: audit.reportMarkdown,
                connector: input.githubConnector,
                installationId: input.githubInstallationId,
              },
              ctx,
            );
            return {
              status: result.status === "updated" ? "updated" : "created",
              result,
            };
          }),
        );
      } else {
        publications.push({
          surface: "github-pr-comment",
          status: "skipped",
          result: { reason: "No pull request was found for the deployment commit." },
        });
      }
    } else {
      publications.push(
        {
          surface: "github-check-run",
          status: "skipped",
          result: { reason: "GitHub owner, repo, or commit SHA was missing from deployment metadata." },
        },
        {
          surface: "github-pr-resolution",
          status: "skipped",
          result: { reason: "GitHub owner, repo, or commit SHA was missing from deployment metadata." },
        },
        {
          surface: "github-pr-comment",
          status: "skipped",
          result: { reason: "GitHub owner, repo, or commit SHA was missing from deployment metadata." },
        },
      );
    }

    return {
      deployment: {
        id: input.deploymentId,
        url: input.deploymentUrl,
        eventType: input.eventType,
        target: input.target,
        projectName: input.projectName,
        projectId: input.projectId,
        repository: input.owner && input.repo ? `${input.owner}/${input.repo}` : undefined,
        commitSha: input.commitSha,
      },
      audit,
      publications,
    };
  },
});

function asTool<Input, Output>(tool: unknown): ToolLike<Input, Output> {
  return tool as ToolLike<Input, Output>;
}

async function safePublish(
  surface: PublicationResult["surface"],
  publish: () => Promise<Omit<PublicationResult, "surface">>,
): Promise<PublicationResult> {
  try {
    return {
      surface,
      ...(await publish()),
    };
  } catch (error) {
    return {
      surface,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
