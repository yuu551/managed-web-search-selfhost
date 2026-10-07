# managed-web-search-selfhost

Amazon Bedrock AgentCore Gateway のマネージド Web Search Tool を自分の AWS アカウントに CDK でデプロイし、MCP サーバーとして使えるようにするプロジェクトです。Web 検索を持たない MCP クライアント（Bedrock 経由の Claude Code、ローカル LLM のクライアント、自作エージェントなど）に Web 検索を追加できます。

- 検索インデックスは Amazon が運用していて、検索クエリは AWS の外に出ません
- 検索 API キーの契約もサーバーの運用も不要です
- 認証方式は2つ用意しています。既定では IAM 方式だけを作り、API Key 方式は `-c authModes=apikey,iam` を付けたときに作ります
  - **API Key 方式**: URL とヘッダーを設定するだけで、ほとんどのクライアントから使えます
  - **IAM 方式**: AWS の認証情報（awsume など）をそのまま使います。シークレットの管理が不要です

設計の詳細は [docs/design.md](docs/design.md) にまとめています。

## 構成

```
MCP クライアント ──Bearer──▶ Gateway (NONE + Interceptor λ で API Key 検証, WAF) ─┐
MCP クライアント ──SigV4──▶ Gateway (AWS_IAM) ───────────────────────────────────┴─▶ Web Search Connector
```

## 前提

- Node.js 22 以上と pnpm
- AWS 認証情報（`awsume` などで設定済みのもの）
- 対応リージョン: `us-east-1` / `eu-west-1` / `ap-northeast-1`
- 対象のアカウントとリージョンで `cdk bootstrap` を実行済みであること
- IAM 方式を使う場合は `uv`（`uvx`）

## デプロイ

```bash
pnpm install
pnpm test          # ユニットテストと CDK テンプレートのテスト
pnpm run deploy    # cdk-outputs.json に URL などが出力される
pnpm smoke         # 実環境の E2E テスト（両方式で接続・検索・不正キーの拒否を確認）
```

リージョンは `AWS_REGION` / `CDK_DEFAULT_REGION` で決まります。東京リージョンにデプロイする例は次のとおりです。

```bash
AWS_REGION=ap-northeast-1 pnpm run deploy
```

### オプション（`-c key=value` で指定）

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `authModes` | `iam` | 作成する Gateway。`apikey` で API Key 方式、`apikey,iam` で両方を作る |
| `excludeDomains` | なし | 検索結果から常に除外するドメイン（カンマ区切り） |
| `enableWaf` | `true` | API Key 方式の Gateway に WAF を付けるか |
| `wafRequestsPer5MinPerIp` | `300` | WAF で許可する 1 IP あたりのリクエスト数（5 分間） |
| `searchesPerMinute` | `60` | Gateway ごとの WebSearch 呼び出し上限（全クライアントの合計、1 分あたり） |
| `stackName` | `ManagedWebSearch` | スタック名（Gateway 名のプレフィックスにもなる） |

```bash
pnpm run deploy -c authModes=apikey,iam   # API Key 方式も作る（WAF の固定費が月 $6 程度かかる）
pnpm run deploy -c excludeDomains=example.com,example.net -c searchesPerMinute=30
```

## クライアントからの接続

次のコマンドで、各クライアント向けの設定がそのまま出力されます。

```bash
pnpm mcp-config             # API Key はプレースホルダーで表示
pnpm mcp-config --with-key  # API Key を埋め込んで表示
```

### API Key 方式

Streamable HTTP に対応したクライアントでは、URL とヘッダーを設定します。ヘッダーは `Authorization: Bearer <key>` と `x-api-key: <key>` のどちらでも構いません。

```bash
# Claude Code
claude mcp add --transport http websearch <ApiKeyGatewayUrl> --header "Authorization: Bearer <API_KEY>"
```

```json
{
  "mcpServers": {
    "websearch": {
      "type": "http",
      "url": "<ApiKeyGatewayUrl>",
      "headers": { "Authorization": "Bearer <API_KEY>" }
    }
  }
}
```

stdio しか使えないクライアント（Claude Desktop など）では、`mcp-remote` で中継します。

```json
{
  "mcpServers": {
    "websearch": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "<ApiKeyGatewayUrl>", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <API_KEY>" }
    }
  }
}
```

### IAM 方式

呼び出し元に `bedrock-agentcore:InvokeGateway` が必要です。スタック出力の `IamGatewayInvokePolicyArn` をアタッチしてください。管理者権限があれば追加の設定はいりません。

```bash
# Claude Code
claude mcp add websearch -- uvx mcp-proxy-for-aws@latest <IamGatewayUrl> --service bedrock-agentcore --region us-east-1
```

## ツール

| ツール名 | 引数 |
| --- | --- |
| `web-search___WebSearch` | `query`（必須、200 文字以内）、`maxResults`（1〜25、既定 10）、`filters.domainFilter.include/exclude`、`filters.publishedDateFilter.from/to` |

結果には本文の抜粋、URL、タイトル、公開日が含まれます。利用規約上、検索結果をユーザーに表示するときは出典 URL を残す必要があります。

## 運用

### API Key の追加・ローテーション

シークレットにはカンマ区切りで複数のキーを登録できます。クライアントごとにキーを分けて発行すれば、1つだけ無効にすることもできます。Interceptor はシークレットを 5 分間キャッシュするので、変更が反映されるまで最大 5 分かかります。

```bash
SECRET_ARN=$(jq -r .ManagedWebSearch.ApiKeySecretArn cdk-outputs.json)
NEW_KEY=$(openssl rand -hex 24)
CURRENT=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)
aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" --secret-string "$CURRENT,$NEW_KEY"
```

### コストと攻撃への備え

- Gateway に固定費はかかりません。課金は API 呼び出し（$0.005/1,000 件）と Web Search のクエリ数に応じて発生します
- API Key 方式の Gateway（`NONE` 認証）では、キーの誤ったリクエストもGatewayに届いた時点で課金されます。拒否されたリクエストは Gateway と Lambda の料金だけで、Web Search の料金はかかりません。目安は 100 万リクエストあたり約 $5 です
- そのため既定で次の2つを有効にしています
  - **WAF の IP 単位レート制限**: Gateway より手前で遮断します。固定費は月 $6 程度で、加えて $0.60/100 万リクエストかかります
  - **Gateway のレート制限**（追加料金なし）: WebSearch の呼び出し回数に上限をかけます。キーが漏れても検索料金が青天井になりません
- AWS Budgets で予算アラートを設定しておくと安心です

### 削除

```bash
pnpm run destroy
```

## 開発

```bash
pnpm build   # 型チェック
pnpm test    # vitest
pnpm synth   # テンプレート生成
```
