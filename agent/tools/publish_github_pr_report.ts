import { getToken, type ConnectOptions, type ConnectTokenParams } from "@vercel/connect";
import { defineTool } from "eve/tools";
import { z } from "zod";

const defaultConnector = "github/agentic-web-qa-github";
const defaultMarker = "<!-- agentic-web-qa -->";

interface GitHubComment {
  readonly id: number;
  readonly body?: string;
  readonly html_url?: string;
}

export default defineTool({
  description:
    "Publish or update an Agentic Web QA Markdown report as a GitHub pull request comment using a Vercel Connect GitHub connector.",
  inputSchema: z.object({
    owner: z.string().min(1).describe("GitHub repository owner or organization."),
    repo: z.string().min(1).describe("GitHub repository name."),
    pullRequestNumber: z.number().int().positive().describe("Pull request number to comment on."),
    reportMarkdown: z.string().min(1).describe("Markdown report body to post."),
    connector: z
      .string()
      .optional()
      .describe("Optional Vercel Connect connector UID. Defaults to GITHUB_CONNECTOR."),
    installationId: z
      .string()
      .optional()
      .describe("Optional GitHub installation id when the connector has multiple installations."),
    marker: z.string().optional().describe("Hidden marker used to update an existing bot comment."),
  }),
  async execute(input) {
    const owner = input.owner.trim();
    const repo = input.repo.trim();
    const repository = `${owner}/${repo}`;
    const marker = input.marker ?? defaultMarker;
    const body = `${marker}\n${input.reportMarkdown.trim()}\n`;
    const token = await getGitHubToken({
      connector: input.connector,
      installationId: input.installationId,
      repository,
    });

    const comments = await githubRequest<GitHubComment[]>(
      token,
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${input.pullRequestNumber}/comments?per_page=100`,
    );
    const existing = comments.find((comment) => comment.body?.includes(marker));

    if (existing) {
      const updated = await githubRequest<GitHubComment>(
        token,
        "PATCH",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${existing.id}`,
        { body },
      );
      return {
        status: "updated",
        repository,
        pullRequestNumber: input.pullRequestNumber,
        commentUrl: updated.html_url,
      };
    }

    const created = await githubRequest<GitHubComment>(
      token,
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${input.pullRequestNumber}/comments`,
      { body },
    );
    return {
      status: "created",
      repository,
      pullRequestNumber: input.pullRequestNumber,
      commentUrl: created.html_url,
    };
  },
});

async function getGitHubToken(input: {
  readonly connector?: string;
  readonly installationId?: string;
  readonly repository: string;
}): Promise<string> {
  const connector = input.connector ?? process.env.GITHUB_CONNECTOR ?? defaultConnector;
  const installationId = input.installationId ?? process.env.GITHUB_CONNECT_INSTALLATION_ID;
  const params: ConnectTokenParams = {
    subject: { type: "app" },
    authorizationDetails: [
      {
        type: "github_app_installation",
        repositories: input.repository,
        permissions: ["contents:read", "issues:write", "pull_requests:read"],
      },
    ],
  };

  if (installationId) {
    params.installationId = installationId;
  }

  const options: ConnectOptions | undefined = process.env.VERCEL_TOKEN
    ? { vercelToken: process.env.VERCEL_TOKEN }
    : undefined;

  return getToken(connector, params, options);
}

async function githubRequest<T>(
  token: string,
  method: "GET" | "PATCH" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub ${method} ${path} failed with ${response.status}: ${text}`);
  }

  return (await response.json()) as T;
}
