import { defineTool } from "eve/tools";
import { z } from "zod";

import { getGitHubConnectToken, githubRequest } from "../lib/github_connect.js";

interface AssociatedPullRequest {
  readonly number: number;
  readonly state: string;
  readonly title?: string;
  readonly html_url?: string;
}

export default defineTool({
  description:
    "Resolve the GitHub pull request associated with a commit SHA using a scoped Vercel Connect GitHub token.",
  inputSchema: z.object({
    owner: z.string().min(1).describe("GitHub repository owner or organization."),
    repo: z.string().min(1).describe("GitHub repository name."),
    commitSha: z.string().min(7).describe("Commit SHA from the Vercel preview deployment metadata."),
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
    const commitSha = input.commitSha.trim();
    const token = await getGitHubConnectToken({
      connector: input.connector,
      installationId: input.installationId,
      repository,
      permissions: ["contents:read", "pull_requests:read"],
    });

    const pullRequests = await githubRequest<AssociatedPullRequest[]>(
      token,
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(commitSha)}/pulls`,
    );
    const selected = pullRequests.find((pullRequest) => pullRequest.state === "open") ?? pullRequests[0];

    if (!selected) {
      return {
        found: false,
        repository,
        commitSha,
      };
    }

    return {
      found: true,
      repository,
      commitSha,
      pullRequestNumber: selected.number,
      state: selected.state,
      title: selected.title,
      url: selected.html_url,
    };
  },
});
