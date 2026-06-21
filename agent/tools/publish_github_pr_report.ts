import { defineTool } from "eve/tools";
import { z } from "zod";

import { getGitHubConnectToken, githubRequest } from "../lib/github_connect.js";

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
    const token = await getGitHubConnectToken({
      connector: input.connector,
      installationId: input.installationId,
      repository,
      permissions: ["contents:read", "issues:write", "pull_requests:read"],
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
