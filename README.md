# managed-web-search-selfhost

Amazon Bedrock AgentCore Gateway のマネージド Web Search Tool を CDK で自身の AWS アカウントへデプロイし、MCP サーバーとして利用するためのプロジェクトです。Bedrock 経由の Claude Code やローカル LLM、自作エージェントなど、Web 検索機能を持たない MCP クライアントに検索機能を提供します。

- 検索インデックスは Amazon 側で運用されており、検索クエリは AWS の外に出ません
- 外部の検索 API を契約したり、サーバーを独自に管理したりする負担がありません
- 認証方式は IAM 方式・Cognito 方式・API Key 方式の3通りに対応しています。標準では IAM 方式を作成し、ほかの方式は `-c authModes=iam,cognito` のように指定して追加します
  - Cognito 方式: ブラウザでログインし、有効期限 1 時間のトークンで接続します。AWS アカウントを持たない人にも配れます
  - API Key 方式: URL とヘッダーを設定すれば、幅広いクライアントからそのまま接続できます。ただし推奨しません（理由は [API Key 方式](#api-key-方式) を参照）
  - IAM 方式: `awsume` などの AWS 認証情報をそのまま使うため、シークレットの管理が不要です

設計の詳細は [docs/design.md](docs/design.md) にまとめています。

## 構成

![構成図](docs/images/architecture.png)

図の元データは [docs/images/architecture.drawio](docs/images/architecture.drawio) です。

## 注意事項

- **API Key 方式はあまり推奨しません。** Gateway を認証なし（`NONE`）で公開し、キーの検証を Interceptor Lambda に任せる構成です。キーが漏れると誰でも検索でき、誤ったキーのリクエストにも Gateway と Lambda の料金がかかります。AWS の認証情報を使える環境では IAM 方式を使ってください
- 検索結果をユーザーに表示するときは、利用規約に従って出典 URL を残してください。検索結果を大量に保存・複製する用途や、競合する検索インデックスを作る用途には使えません

## 前提

- Node.js 22 以上と pnpm
- AWS 認証情報（`awsume` などで設定済みのもの）
- 対応リージョン（`us-east-1` / `eu-west-1` / `ap-northeast-1`）
- 対象のアカウントとリージョンで `cdk bootstrap` を実行済みであること
- IAM 方式を使う場合は `uv`（`uvx`）

## デプロイ

```bash
pnpm install
pnpm test          # ユニットテストと CDK テンプレートのテスト
pnpm run deploy    # cdk-outputs.json に URL などが出力される
pnpm smoke         # 実環境の E2E テスト（各方式で接続・検索・不正な認証情報の拒否を確認）
```

デプロイ先のリージョンは `AWS_REGION` や `CDK_DEFAULT_REGION` を参照します。東京リージョンへデプロイする場合は次のように環境変数を指定します。

```bash
AWS_REGION=ap-northeast-1 pnpm run deploy
```

Cognito 方式のログインまで E2E テストする場合は、テスト用ユーザーの認証情報を渡します。

```bash
COGNITO_TEST_USERNAME=user@example.com COGNITO_TEST_PASSWORD='...' pnpm smoke
```

### デプロイオプション（`-c key=value` で指定）

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `authModes` | `iam` | 作成する Gateway。`iam` / `cognito` / `apikey` をカンマ区切りで指定する |
| `excludeDomains` | なし | 検索結果から常に除外するドメイン（カンマ区切り） |
| `enableWaf` | `true` | API Key 方式の Gateway に WAF を付けるか |
| `wafRequestsPer5MinPerIp` | `300` | WAF で許可する 1 IP あたりのリクエスト数（5 分間） |
| `searchesPerMinute` | `60` | Gateway ごとの WebSearch 呼び出し上限（全クライアントの合計、1 分あたり） |
| `allowedIps` | なし | 接続を許可する送信元 IP（IPv4 / IPv6 の CIDR をカンマ区切りで混在可）。IAM 方式は Gateway のリソースポリシー、Cognito 方式と API Key 方式は WAF の IP セットで制限する |
| `oauthCallbackUrls` | `http://localhost:53280/callback` | Cognito 方式で MCP クライアントが待ち受けるコールバック URL（カンマ区切り） |
| `accessTokenValidityMinutes` | `60` | Cognito 方式のアクセストークンの有効期限（分、5〜1440） |
| `refreshTokenValidityDays` | `7` | Cognito 方式のリフレッシュトークンの有効期限（日）。切れると再ログインが必要になる |
| `stackName` | `ManagedWebSearch` | スタック名（Gateway 名のプレフィックスにもなる） |

```bash
pnpm run deploy -c authModes=apikey,iam   # API Key 方式も作る（WAF の固定費が月 $6 程度かかる）
pnpm run deploy -c excludeDomains=example.com,example.net -c searchesPerMinute=30
pnpm run deploy -c allowedIps=203.0.113.0/24,2001:db8::/32
```

## クライアントからの接続

次のコマンドを実行すると、各クライアント向けの設定が出力されます。

```bash
pnpm mcp-config             # API Key はプレースホルダーで表示
pnpm mcp-config --with-key  # API Key を埋め込んで表示
```

### API Key 方式

> [!WARNING]
> API Key 方式はあまり推奨しません。Gateway 自体は認証なし（`NONE`）で公開され、キーの検証を Interceptor Lambda に任せる構成のため、キーが漏れると誰でも検索できます。また、誤ったキーのリクエストも Gateway と Lambda の課金対象になり、対策の WAF には固定費がかかります。AWS の認証情報を使える環境では IAM 方式を使ってください。

Streamable HTTP に対応したクライアントでは、URL とヘッダーを指定します。ヘッダーには `Authorization: Bearer <key>` または `x-api-key: <key>` を設定します。

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

Claude Desktop などの stdio 接続を使うクライアントでは、`mcp-remote` で中継します。

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

呼び出し元には `bedrock-agentcore:InvokeGateway` 権限が必要です。スタック出力に含まれる `IamGatewayInvokePolicyArn` をアタッチしてください。管理者権限がある環境なら追加の設定は不要です。

```bash
# Claude Code
claude mcp add websearch -- uvx mcp-proxy-for-aws@latest <IamGatewayUrl> --service bedrock-agentcore --region us-east-1
```

### Cognito 方式

利用者は Cognito のユーザーとして招待します。セルフサインアップは無効にしています。

```bash
aws cognito-idp admin-create-user --user-pool-id <CognitoUserPoolId> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true
```

Claude Code には、クライアント ID とコールバックポートを指定して登録します。

```bash
claude mcp add --transport http websearch <CognitoGatewayUrl> --client-id <CognitoClientId> --callback-port 53280
claude mcp login websearch   # Claude Code の中で /mcp から認証しても同じ
```

ログインの流れは次のとおりです。

1. Claude Code が Gateway に接続すると 401 が返り、Gateway の OAuth メタデータ（`/.well-known/oauth-protected-resource`）から Cognito が認可サーバーだと分かります。利用者が設定するのはクライアント ID だけです
2. ブラウザで Cognito のログイン画面が開きます。招待メールの仮パスワードで初回ログインすると、新しいパスワードの設定を求められます
3. ログインすると `http://localhost:53280/callback` にリダイレクトされ、Claude Code がトークンを受け取ります。ブラウザはそのまま閉じて構いません
4. アクセストークンは 1 時間で切れ、リフレッシュトークン（7 日）で自動更新されます。リフレッシュトークンが切れたら、もう一度ログインします

利用を止めるときは、ユーザーを無効化してサインアウトさせます。発行済みのアクセストークンは期限（最大 1 時間）まで使えます。

```bash
aws cognito-idp admin-disable-user --user-pool-id <CognitoUserPoolId> --username user@example.com
aws cognito-idp admin-user-global-sign-out --user-pool-id <CognitoUserPoolId> --username user@example.com
```

Cognito は動的クライアント登録に対応していないため、クライアント ID を事前に設定できない MCP クライアントからは使えません。

## ツール

| ツール名 | 引数 |
| --- | --- |
| `web-search___WebSearch` | `query`（必須、200 文字以内）、`maxResults`（1〜25、既定 10）、`filters.domainFilter.include/exclude`、`filters.publishedDateFilter.from/to` |

検索結果には本文の抜粋、URL、タイトル、公開日が含まれます。利用規約上、結果をユーザーへ表示する際は出典 URL を残す必要があります。

## 運用

### IP 制限

`allowedIps` を指定すると、許可リスト外の送信元からの呼び出しを拒否します。IAM 方式では Gateway のリソースポリシーに明示的な Deny を付けるので、管理者権限を持つ呼び出し元も拒否され、追加料金はかかりません。Cognito 方式と API Key 方式では WAF の IP セットで遮断します。WAF の固定費は月 $6 程度です。

- Cognito 方式（JWT 認証）でリソースポリシーの `aws:SourceIp` 条件を使うと、許可リスト内の送信元も含めてすべて拒否されました。JWT 認証のリクエストでは送信元 IP がポリシー評価に使われないためです。そのため Cognito 方式は WAF で制限しています

- 許可する IP は、AWS から見える送信元 IP で指定してください。VPN や Cloudflare WARP などを経由すると、`curl https://checkip.amazonaws.com` の結果が接続のたびに変わることがあります。CloudTrail の `sourceIPAddress` でも確認できます
- 2026 年 10 月時点では Gateway のエンドポイントに AAAA レコードがなく、IPv4 でしか接続できません。IPv6 の CIDR も指定できるので、エンドポイントがデュアルスタックに対応すればそのまま有効になります

### API Key の追加・ローテーション

シークレットにはカンマ区切りで複数のキーを登録できます。クライアントごとに個別のキーを発行しておけば、特定のキーを個別に失効させられます。Interceptor がシークレットを 5 分間キャッシュするため、設定変更の反映には最大 5 分かかります。

```bash
SECRET_ARN=$(jq -r .ManagedWebSearch.ApiKeySecretArn cdk-outputs.json)
NEW_KEY=$(openssl rand -hex 24)
CURRENT=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)
aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" --secret-string "$CURRENT,$NEW_KEY"
```

### コストと攻撃への備え

- Gateway 自体に固定費はなく、API 呼び出し（1,000 件あたり $0.005）と Web Search のクエリ数に応じて課金されます。
- API Key 方式（`NONE` 認証）の Gateway では、誤ったキーのリクエストも Gateway に届いた時点で課金対象になります。認証で拒否されたリクエストでは Web Search は実行されないため検索料金は発生せず、Gateway と Lambda の呼び出し料金（100 万リクエストあたり約 $5）が発生します。
- 意図しない課金の急増を防ぐため、次の 2 つのレート制限を用意しています。
  - WAF による IP 単位のレート制限（API Key 方式の Gateway で既定で有効）。Gateway の手前でリクエストを遮断します。費用は月額約 $6 の固定費と、100 万リクエストあたり $0.60 の従量料金です。
  - Gateway 本体のレート制限（両方式で有効、追加料金なし）。Web Search の呼び出し回数に上限を設け、キーが漏洩した場合でも検索費用の膨張を防ぎます。
- 想定外の支出を早期に検知できるよう、AWS Budgets で予算アラートを設定しておくことを推奨します。

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
