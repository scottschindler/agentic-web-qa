import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

import vercelChannel from "../agent/channels/vercel.js";

type VercelRoute = (typeof vercelChannel.routes)[number] & {
  readonly handler: (request: Request, args: MockRouteArgs) => Promise<Response>;
};

interface MockRouteArgs {
  readonly send: (input: unknown, options: unknown) => Promise<MockSession>;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly getSession: never;
  readonly receive: never;
  readonly params: Record<string, string>;
  readonly requestIp: string | null;
}

interface MockSession {
  readonly id: string;
  readonly continuationToken: string;
  getEventStream(): Promise<ReadableStream>;
}

const deploymentRoute = vercelChannel.routes.find(
  (candidate) => candidate.method === "POST" && candidate.path === "/deployment",
) as VercelRoute | undefined;

if (!deploymentRoute) {
  throw new Error("Expected the Vercel deployment webhook route to be registered.");
}

const route: VercelRoute = deploymentRoute;

const previousSecret = process.env.AGENTIC_WEB_QA_WEBHOOK_SECRET;
const previousMaxPages = process.env.AGENTIC_WEB_QA_MAX_PAGES;
const previousMaxClicks = process.env.AGENTIC_WEB_QA_MAX_CLICKS_PER_PAGE;
process.env.AGENTIC_WEB_QA_WEBHOOK_SECRET = "test-webhook-secret";
process.env.AGENTIC_WEB_QA_MAX_PAGES = "7";
process.env.AGENTIC_WEB_QA_MAX_CLICKS_PER_PAGE = "9";

try {
  await verifiesSignedDeploymentReadyWebhook();
  await rejectsInvalidSignature();
  await ignoresNonReadyEvent();
  console.log("Vercel webhook channel verification passed.");
} finally {
  restoreEnv("AGENTIC_WEB_QA_WEBHOOK_SECRET", previousSecret);
  restoreEnv("AGENTIC_WEB_QA_MAX_PAGES", previousMaxPages);
  restoreEnv("AGENTIC_WEB_QA_MAX_CLICKS_PER_PAGE", previousMaxClicks);
}

async function verifiesSignedDeploymentReadyWebhook(): Promise<void> {
  const sent: Array<{ input: unknown; options: unknown }> = [];
  const body = JSON.stringify({
    id: "evt_123",
    type: "deployment.ready",
    payload: {
      deployment: {
        id: "dpl_123",
        name: "demo-app",
        target: "preview",
        url: "demo-app-git-feature-user.vercel.app",
        meta: {
          githubCommitOrg: "acme",
          githubCommitRepo: "demo-app",
          githubCommitSha: "abc123def456",
        },
      },
      project: {
        id: "prj_123",
        name: "demo-app",
      },
    },
  });
  const response = await route.handler(signedRequest(body), mockArgs(sent));
  const json = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 202);
  assert.equal(json.accepted, true);
  assert.equal(json.sessionId, "sess_test");
  assert.equal(json.deploymentUrl, "https://demo-app-git-feature-user.vercel.app");
  assert.equal(json.repository, "acme/demo-app");
  assert.equal(json.commitSha, "abc123def456");
  assert.equal(sent.length, 1);

  const sentInput = sent[0]!.input as {
    readonly message?: string;
    readonly context?: readonly string[];
  };
  const sentOptions = sent[0]!.options as {
    readonly continuationToken?: string;
    readonly mode?: string;
    readonly auth?: { readonly principalType?: string; readonly principalId?: string };
  };

  assert.equal(sentOptions.mode, "task");
  assert.equal(sentOptions.continuationToken, "deployment-dpl_123-deployment.ready");
  assert.equal(sentOptions.auth?.principalType, "service");
  assert.equal(sentOptions.auth?.principalId, "dpl_123");
  assert.ok(sentInput.message?.includes("audit_vercel_preview_deployment"));
  assert.ok(sentInput.message?.includes('owner="acme"'));
  assert.ok(sentInput.message?.includes('repo="demo-app"'));
  assert.ok(sentInput.message?.includes('commitSha="abc123def456"'));
  assert.ok(sentInput.message?.includes("maxPages=7"));
  assert.ok(sentInput.message?.includes("maxClicksPerPage=9"));
  assert.ok(sentInput.context?.some((line) => line.includes("Vercel deployment webhook")));
}

async function rejectsInvalidSignature(): Promise<void> {
  const response = await route.handler(
    new Request("https://agent.example.com/deployment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vercel-signature": "00",
      },
      body: JSON.stringify({ type: "deployment.ready" }),
    }),
    mockArgs([]),
  );

  assert.equal(response.status, 401);
}

async function ignoresNonReadyEvent(): Promise<void> {
  const sent: Array<{ input: unknown; options: unknown }> = [];
  const body = JSON.stringify({
    id: "evt_ignored",
    type: "deployment.created",
    payload: {
      deployment: {
        id: "dpl_ignored",
        url: "ignored.vercel.app",
      },
    },
  });
  const response = await route.handler(signedRequest(body), mockArgs(sent));
  const json = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 202);
  assert.equal(json.accepted, false);
  assert.equal(json.reason, "ignored-event");
  assert.equal(sent.length, 0);
}

function signedRequest(body: string): Request {
  return new Request("https://agent.example.com/deployment", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vercel-signature": createHmac("sha1", process.env.AGENTIC_WEB_QA_WEBHOOK_SECRET!)
        .update(Buffer.from(body))
        .digest("hex"),
    },
    body,
  });
}

function mockArgs(sent: Array<{ input: unknown; options: unknown }>): MockRouteArgs {
  return {
    send: async (input, options) => {
      sent.push({ input, options });
      return {
        id: "sess_test",
        continuationToken: "vercel:deployment-dpl_123-deployment.ready",
        async getEventStream() {
          return new ReadableStream();
        },
      };
    },
    waitUntil: () => undefined,
    getSession: undefined as never,
    receive: undefined as never,
    params: {},
    requestIp: null,
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
