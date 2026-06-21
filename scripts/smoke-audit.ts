import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runWebAppAudit } from "../agent/lib/web_qa.js";

const fixtureRoot = path.join(process.cwd(), "fixtures", "buggy-app");

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.join(fixtureRoot, pathname);

  if (!filePath.startsWith(fixtureRoot)) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("Expected an IPv4 server address.");
}

try {
  const result = await runWebAppAudit({
    url: `http://127.0.0.1:${address.port}/`,
    maxPages: 3,
    maxClicksPerPage: 5,
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.findings.length === 0) {
    throw new Error("Expected the buggy fixture to produce at least one finding.");
  }
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
