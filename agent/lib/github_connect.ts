import { getToken, type ConnectOptions, type ConnectTokenParams } from "@vercel/connect";

export const defaultGitHubConnector = "github/agentic-web-qa-github";

export type GitHubConnectPermission =
  | "checks:read"
  | "checks:write"
  | "contents:read"
  | "issues:write"
  | "pull_requests:read";

export async function getGitHubConnectToken(input: {
  readonly connector?: string;
  readonly installationId?: string;
  readonly repository: string;
  readonly permissions: readonly GitHubConnectPermission[];
}): Promise<string> {
  const connector = input.connector ?? process.env.GITHUB_CONNECTOR ?? defaultGitHubConnector;
  const installationId = input.installationId ?? process.env.GITHUB_CONNECT_INSTALLATION_ID;
  const params: ConnectTokenParams = {
    subject: { type: "app" },
    authorizationDetails: [
      {
        type: "github_app_installation",
        repositories: input.repository,
        permissions: [...input.permissions],
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

export async function githubRequest<T>(
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
