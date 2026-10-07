// デプロイ済み Gateway に接続するための MCP クライアント設定を出力する
// 使い方: pnpm mcp-config            （API Key はプレースホルダーで表示）
//        pnpm mcp-config --with-key （API Key を埋め込んで表示）
import { getApiKey, loadOutputs } from "./lib";

const NAME = "websearch";

async function main() {
  const outputs = await loadOutputs();
  const withKey = process.argv.includes("--with-key");

  if (outputs.ApiKeyGatewayUrl) {
    const url = outputs.ApiKeyGatewayUrl;
    const key = withKey ? await getApiKey(outputs) : "<API_KEY>";

    console.log(`# API Key 方式  (${url})\n`);
    if (!withKey) {
      console.log("API Key の取得:");
      console.log(
        `  aws secretsmanager get-secret-value --region ${outputs.Region} --secret-id ${outputs.ApiKeySecretArn} --query SecretString --output text\n`,
      );
    }

    console.log("## Claude Code");
    console.log(`claude mcp add --transport http ${NAME} ${url} --header "Authorization: Bearer ${key}"\n`);

    console.log("## Streamable HTTP + ヘッダーに対応したクライアント（Cursor / Cline / LM Studio など、mcp.json 形式）");
    console.log(
      JSON.stringify({ mcpServers: { [NAME]: { type: "http", url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
      "\n",
    );

    console.log("## VS Code (.vscode/mcp.json)  ※キーは初回に入力を求められ、VS Code 側に保存される");
    console.log(
      JSON.stringify(
        {
          inputs: [{ type: "promptString", id: "websearch-key", description: "Web Search API Key", password: true }],
          servers: { [NAME]: { type: "http", url, headers: { Authorization: "Bearer ${input:websearch-key}" } } },
        },
        null,
        2,
      ),
      "\n",
    );

    console.log("## stdio しか使えないクライアント（Claude Desktop など）: mcp-remote で中継");
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            [NAME]: {
              command: "npx",
              args: ["-y", "mcp-remote@latest", url, "--header", "Authorization:${AUTH_HEADER}"],
              env: { AUTH_HEADER: `Bearer ${key}` },
            },
          },
        },
        null,
        2,
      ),
      "\n",
    );
  }

  if (outputs.IamGatewayUrl) {
    const url = outputs.IamGatewayUrl;
    const proxyArgs = ["mcp-proxy-for-aws@latest", url, "--service", "bedrock-agentcore", "--region", outputs.Region];

    console.log(`# IAM 方式  (${url})\n`);
    console.log(`呼び出し元の IAM ユーザー / ロールに ${outputs.IamGatewayInvokePolicyArn} をアタッチ（または同等の権限を付与）する。`);
    console.log("認証情報は通常の AWS クレデンシャルチェーン（環境変数・プロファイル・awsume など）から読み込まれる。\n");

    console.log("## Claude Code");
    console.log(`claude mcp add ${NAME} -- uvx ${proxyArgs.join(" ")}\n`);

    console.log("## mcp.json 形式（stdio）  ※プロファイルを固定するなら --profile <name> を追加");
    console.log(JSON.stringify({ mcpServers: { [NAME]: { command: "uvx", args: proxyArgs } } }, null, 2), "\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
