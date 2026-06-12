import path from "node:path";
import { sampleGmailEvents } from "@what-did-i-miss/shared";
import { CodexAppServerClient, parseFindings } from "../src/main/codex";

const appRoot = path.resolve(import.meta.dir, "..");
const client = new CodexAppServerClient(appRoot);

try {
  await client.initialize();
  const response = await client.triage({
    gmail: sampleGmailEvents,
    telegram: []
  });
  const findings = parseFindings(response);

  console.log(JSON.stringify({
    status: "ok",
    findings: findings.map((finding) => ({
      priority: finding.priority,
      sourceId: finding.sourceId,
      accountEmail: finding.accountEmail,
      title: finding.title
    })),
    rawResponseLength: response.length
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
} finally {
  client.close();
}
