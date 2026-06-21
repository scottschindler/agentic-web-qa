import { defineTool } from "eve/tools";
import { z } from "zod";

import { runWebAppAuditInSandbox } from "../lib/sandbox_web_qa.js";

export default defineTool({
  description:
    "Run a bounded Playwright smoke test against a web app in the Eve sandbox: optional login, same-origin crawl, safe clicks, console/network/page errors, and screenshots.",
  inputSchema: z.object({
    url: z.string().url().describe("The app URL to audit."),
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
    artifactDir: z.string().optional().describe("Optional directory where screenshots should be saved."),
    vercelAutomationBypassSecret: z
      .string()
      .optional()
      .describe(
        "Optional Vercel Deployment Protection bypass secret. Usually read from VERCEL_AUTOMATION_BYPASS_SECRET.",
      ),
  }),
  async execute(input, ctx) {
    return runWebAppAuditInSandbox(input, ctx);
  },
});
