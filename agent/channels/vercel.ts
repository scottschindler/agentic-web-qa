import { randomUUID } from "node:crypto";

import { defineChannel, POST } from "eve/channels";

interface VercelWebhookBody {
  readonly id?: string;
  readonly type?: string;
  readonly payload?: {
    readonly deployment?: {
      readonly id?: string;
      readonly name?: string;
      readonly target?: string;
      readonly url?: string;
      readonly meta?: Record<string, unknown>;
    };
    readonly name?: string;
    readonly project?: {
      readonly id?: string;
      readonly name?: string;
    };
    readonly projectId?: string;
    readonly target?: string;
  };
}

export default defineChannel({
  routes: [
    POST("/deployment", async (request, { send, waitUntil }) => {
      if (!isAuthorized(request)) {
        return Response.json({ accepted: false, error: "unauthorized" }, { status: 401 });
      }

      const body = (await request.json()) as VercelWebhookBody;
      const eventType = body.type ?? "unknown";

      if (!isDeploymentReadyEvent(eventType)) {
        return Response.json({ accepted: false, reason: "ignored-event", eventType }, { status: 202 });
      }

      const deployment = body.payload?.deployment;
      const deploymentUrl = normalizeDeploymentUrl(deployment?.url);
      if (!deploymentUrl) {
        return Response.json(
          { accepted: false, error: "missing deployment URL", eventType },
          { status: 400 },
        );
      }

      const target = deployment?.target ?? body.payload?.target ?? "preview";
      if (target === "production" && process.env.AGENTIC_WEB_QA_AUDIT_PRODUCTION !== "true") {
        return Response.json(
          { accepted: false, reason: "production deployments are skipped by default", eventType, target },
          { status: 202 },
        );
      }

      const metadata = deployment?.meta ?? {};
      const owner = pickString(
        metadata.githubCommitOrg,
        metadata.githubOrg,
        metadata.githubRepoOwner,
        metadata.githubCommitRepoOwner,
      );
      const repo = pickString(metadata.githubCommitRepo, metadata.githubRepo, metadata.githubRepository);
      const commitSha = pickString(metadata.githubCommitSha, metadata.githubCommit);
      const deploymentId = deployment?.id ?? body.id ?? randomUUID();
      const continuationToken = `deployment-${deploymentId}-${eventType}`;
      const maxPages = parseOptionalInt(process.env.AGENTIC_WEB_QA_MAX_PAGES) ?? 5;
      const maxClicksPerPage =
        parseOptionalInt(process.env.AGENTIC_WEB_QA_MAX_CLICKS_PER_PAGE) ?? 8;

      waitUntil(
        send(
          {
            message: buildAuditMessage({
              deploymentUrl,
              eventType,
              target,
              deploymentId,
              projectName: deployment?.name ?? body.payload?.project?.name ?? body.payload?.name,
              projectId: body.payload?.project?.id ?? body.payload?.projectId,
              owner,
              repo,
              commitSha,
              maxPages,
              maxClicksPerPage,
            }),
            context: [
              "This session was started by a Vercel deployment webhook.",
              "Run as a task. Do not ask follow-up questions unless the deployment URL is unusable.",
            ],
          },
          {
            auth: {
              authenticator: "vercel-webhook",
              principalType: "service",
              principalId: deploymentId,
              attributes: compactAttributes({
                deploymentId,
                deploymentUrl,
                eventType,
                target,
                owner,
                repo,
                commitSha,
              }),
            },
            continuationToken,
            mode: "task",
          },
        ),
      );

      return Response.json(
        {
          accepted: true,
          eventType,
          target,
          deploymentUrl,
          continuationToken,
          repository: owner && repo ? `${owner}/${repo}` : undefined,
          commitSha,
        },
        { status: 202 },
      );
    }),
  ],
});

function isAuthorized(request: Request): boolean {
  const secret = process.env.AGENTIC_WEB_QA_WEBHOOK_SECRET;
  if (!secret) return true;

  const url = new URL(request.url);
  const authorization = request.headers.get("authorization");
  const headerSecret = request.headers.get("x-agentic-web-qa-secret");

  return (
    authorization === `Bearer ${secret}` ||
    headerSecret === secret ||
    url.searchParams.get("secret") === secret
  );
}

function isDeploymentReadyEvent(eventType: string): boolean {
  return (
    eventType === "deployment.ready" ||
    eventType === "deployment.succeeded" ||
    eventType === "deployment-ready" ||
    eventType === "deployment-succeeded"
  );
}

function normalizeDeploymentUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function buildAuditMessage(input: {
  readonly deploymentUrl: string;
  readonly eventType: string;
  readonly target: string;
  readonly deploymentId: string;
  readonly projectName?: string;
  readonly projectId?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly commitSha?: string;
  readonly maxPages: number;
  readonly maxClicksPerPage: number;
}): string {
  const lines = [
    "A Vercel preview deployment is ready. Run the Agentic Web App QA audit now.",
    "",
    `Deployment URL: ${input.deploymentUrl}`,
    `Event type: ${input.eventType}`,
    `Target: ${input.target}`,
    `Deployment ID: ${input.deploymentId}`,
    input.projectName ? `Project: ${input.projectName}` : undefined,
    input.projectId ? `Project ID: ${input.projectId}` : undefined,
    input.owner && input.repo ? `GitHub repository: ${input.owner}/${input.repo}` : undefined,
    input.commitSha ? `Commit SHA: ${input.commitSha}` : undefined,
    "",
    "Steps:",
    `1. Call audit_web_app with url=${JSON.stringify(input.deploymentUrl)}, maxPages=${input.maxPages}, maxClicksPerPage=${input.maxClicksPerPage}.`,
    "2. Summarize the highest-priority findings, pages visited, clicks tested, skipped destructive controls, and screenshot artifact paths.",
  ];

  if (input.owner && input.repo && input.commitSha) {
    lines.push(
      `3. Call resolve_github_pull_request for ${input.owner}/${input.repo} at ${input.commitSha}.`,
      "4. If a pull request is found, call publish_github_pr_report with the audit reportMarkdown returned by audit_web_app.",
      "5. If no pull request is found, finish with the report and state that publishing was skipped.",
    );
  } else {
    lines.push("3. GitHub repository metadata was missing, so finish with the report and skip PR publishing.");
  }

  return `${lines.filter(Boolean).join("\n")}\n`;
}

function pickString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }

  return undefined;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactAttributes(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
