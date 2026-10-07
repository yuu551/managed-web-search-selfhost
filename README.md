# managed-web-search-selfhost

Amazon Bedrock AgentCore のマネージド Web Search Tool を CDK で自分の AWS アカウントにデプロイし、MCP サーバーとして使うためのプロジェクトです。Bedrock 経由の Claude Code やローカル LLM のクライアントなど、Web 検索を持たない MCP クライアントに検索機能を追加できます。検索インデックスは Amazon が運用していて、検索クエリは AWS の外に出ません。

![構成図](docs/images/architecture.png)

## 認証方式

| 方式 | 向いている利用者 | 接続方法 |
| --- | --- | --- |
| IAM（既定・推奨） | AWS の認証情報を持つ人 | `mcp-proxy-for-aws` で SigV4 署名する |
| Cognito | AWS アカウントを持たない人 | ブラウザでログインし、有効期限 1 時間のトークンで接続する |
| API Key（非推奨） | OAuth に対応していないクライアント | URL とヘッダーを設定する |

API Key 方式は、Gateway を認証なしで公開し、Lambda 関数側でキーを検証する構成です。キーが漏れると誰でも検索でき、誤ったキーのリクエストにも料金がかかるため、ほかの方式を使えるならそちらを選んでください。

## コスト

| 項目 | 料金 | かかる方式 |
| --- | --- | --- |
| Web Search | 1,000 クエリあたり $7 | 全方式 |
| Gateway の API 呼び出し | 1,000 件あたり $0.005 | 全方式 |
| Cognito | 月 1 万 MAU まで無料。超えた分は 1 MAU あたり $0.015（Essentials） | Cognito |
| AWS WAF | Web ACL が月 $5、ルールが 1 つ月 $1、リクエスト 100 万件あたり $0.60 | API Key（既定で有効）、Cognito の IP 制限 |
| Secrets Manager / Lambda | 月 $0.40 程度 | API Key |

固定費は、IAM 方式と Cognito 方式なら $0 です（Cognito 方式で IP 制限を使う場合は WAF の月 $6 程度）。API Key 方式は WAF とシークレットで月 $6.4 程度かかります。

費用のほとんどは Web Search の検索料金です。1 日 100 回検索すると、月におよそ 3,000 クエリで $21 になります。Gateway ごとに検索回数の上限（既定は 1 分あたり 60 回）を設けていますが、上限まで使い続けると 1 日 $600 程度になるため、`searchesPerMinute` で利用量に合わせて下げ、AWS Budgets で予算アラートを設定しておくことをおすすめします。

料金は 2026 年 10 月時点の us-east-1 のものです。最新の料金は [AgentCore の料金ページ](https://aws.amazon.com/bedrock/agentcore/pricing/) を確認してください。

## 注意事項

- 検索結果をユーザーに表示するときは、利用規約に従って出典 URL を残してください。検索結果を大量に保存・複製する用途や、競合する検索インデックスを作る用途には使えません
- 対応リージョンは `us-east-1` / `eu-west-1` / `ap-northeast-1` です

## デプロイ

Node.js 22 以上、pnpm、AWS 認証情報、`cdk bootstrap` 済みの環境が必要です。IAM 方式で接続するクライアント側には `uv` が必要です。

```bash
pnpm install
pnpm run deploy   # 既定では IAM 方式だけを作る
pnpm smoke        # デプロイした Gateway に接続して検索できるか確認する
```

ほかの方式やオプションは `-c` で指定します。

```bash
pnpm run deploy -c authModes=iam,cognito                # Cognito 方式も作る
pnpm run deploy -c allowedIps=203.0.113.0/24,2001:db8::/32  # 送信元 IP を制限する
```

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `authModes` | `iam` | 作る Gateway。`iam` / `cognito` / `apikey` をカンマ区切りで指定する |
| `searchesPerMinute` | `60` | Gateway ごとの検索回数の上限（1 分あたり） |
| `allowedIps` | なし | 許可する送信元 IP（IPv4 / IPv6 の CIDR、カンマ区切り） |
| `excludeDomains` | なし | 検索結果から除外するドメイン |
| `enableWaf` | `true` | API Key 方式の Gateway に WAF のレート制限を付けるか |
| `wafRequestsPer5MinPerIp` | `300` | WAF で許可する 1 IP あたりのリクエスト数（5 分間） |
| `oauthCallbackUrls` | `http://localhost:53280/callback` | Cognito 方式のコールバック URL |
| `accessTokenValidityMinutes` | `60` | Cognito 方式のアクセストークンの有効期限（分） |
| `refreshTokenValidityDays` | `7` | Cognito 方式のリフレッシュトークンの有効期限（日） |
| `stackName` | `ManagedWebSearch` | スタック名 |

## クライアントから接続する

`pnpm mcp-config` を実行すると、デプロイした Gateway の URL や ID を埋め込んだ設定が出力されます。以下は Claude Code の例です。

### IAM 方式

呼び出し元に `bedrock-agentcore:InvokeGateway` の権限が必要です（スタック出力の `IamGatewayInvokePolicyArn`）。

```bash
claude mcp add websearch -- uvx mcp-proxy-for-aws@latest <IamGatewayUrl> --service bedrock-agentcore --region us-east-1
```

### Cognito 方式

管理者が利用者を招待すると、仮パスワードがメールで届きます。

```bash
aws cognito-idp admin-create-user --user-pool-id <CognitoUserPoolId> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true
```

利用者は Claude Code に登録してから、`/mcp` でログインします。ブラウザで Cognito のログイン画面が開き、ログインすると Claude Code に戻ります。

```bash
claude mcp add --transport http websearch <CognitoGatewayUrl> --client-id <CognitoClientId> --callback-port 53280
```

### API Key 方式

```bash
claude mcp add --transport http websearch <ApiKeyGatewayUrl> --header "Authorization: Bearer <API_KEY>"
```

API Key は `pnpm mcp-config --with-key` で確認できます。

## ツール

| ツール名 | 引数 |
| --- | --- |
| `web-search___WebSearch` | `query`（必須、200 文字以内）、`maxResults`（1〜25、既定 10）、`filters.domainFilter.include/exclude`、`filters.publishedDateFilter.from/to` |

## その他

- 削除: `pnpm run destroy`
- 開発: `pnpm build`（型チェック）、`pnpm test`、`pnpm synth`
- 設計の詳細、IP 制限の仕組み、ユーザーやキーの運用手順は [docs/design.md](docs/design.md) にまとめています

## ライセンス

[MIT](LICENSE)
