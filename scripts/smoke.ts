// デプロイ済み Gateway に MCP クライアントとして接続し、initialize → tools/list → tools/call を検証する
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getApiKey, loadOutputs, sigv4Fetch } from "./lib";

const TOOL = "web-search___WebSearch";
const QUERY = process.argv[2] ?? "Amazon Bedrock AgentCore Web Search Tool";

async function connect(url: string, opts: { headers?: Record<string, string>; fetch?: typeof fetch }) {
  const client = new Client({ name: "smoke-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: opts.headers },
    fetch: opts.fetch,
  });
  await client.connect(transport);
  return client;
}

async function exercise(label: string, client: Client) {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === TOOL);
  assert.ok(tool, `${label}: ${TOOL} not found in tools/list (got ${tools.map((t) => t.name).join(", ")})`);

  const res = await client.callTool({ name: TOOL, arguments: { query: QUERY, maxResults: 3 } });
  assert.equal(res.isError ?? false, false, `${label}: tools/call returned an error: ${JSON.stringify(res.content)}`);
  const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
  const results = JSON.parse(text).results as { title?: string; url?: string }[];
  assert.ok(results.length > 0, `${label}: no search results`);

  console.log(`✅ ${label}: ${results.length} results`);
  for (const r of results) console.log(`   - ${r.title} <${r.url}>`);
  await client.close();
}

async function expectRejected(label: string, url: string, headers: Record<string, string>) {
  try {
    const client = await connect(url, { headers });
    await client.close();
  } catch (e) {
    console.log(`✅ ${label}: rejected (${(e as Error).message.slice(0, 80)})`);
    return;
  }
  assert.fail(`${label}: request without a valid key was accepted`);
}

async function main() {
  const outputs = await loadOutputs();
  let ran = 0;

  if (outputs.ApiKeyGatewayUrl) {
    const key = await getApiKey(outputs);
    await expectRejected("apikey / no key", outputs.ApiKeyGatewayUrl, {});
    await expectRejected("apikey / wrong key", outputs.ApiKeyGatewayUrl, { Authorization: "Bearer wrong-key" });
    await exercise("apikey / Bearer", await connect(outputs.ApiKeyGatewayUrl, { headers: { Authorization: `Bearer ${key}` } }));
    await exercise("apikey / x-api-key", await connect(outputs.ApiKeyGatewayUrl, { headers: { "x-api-key": key } }));
    ran++;
  }

  if (outputs.IamGatewayUrl) {
    await expectRejected("iam / unsigned", outputs.IamGatewayUrl, {});
    await exercise("iam / SigV4", await connect(outputs.IamGatewayUrl, { fetch: sigv4Fetch(outputs.Region) }));
    ran++;
  }

  assert.ok(ran > 0, "No gateway URL found in stack outputs");
  console.log("\nAll smoke tests passed.");
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
