# 設計書: Managed Web Search セルフホスト

## 目的

Amazon Bedrock AgentCore Gateway の Web Search Tool（マネージドConnector）を自分のAWSアカウントにCDKで1コマンドデプロイし、Web検索機能を持たないMCPクライアント（Bedrock経由のClaude Code、ローカルLLMクライアント、自作エージェントなど）からすぐ使えるようにする。

## 前提（調査結果）

| 項目 | 内容 |
| --- | --- |
| 提供形態 | Gateway Target の Connector（`connectorId: "web-search"`）。ツール名は `WebSearch` |
| 対応リージョン | us-east-1 / eu-west-1 / ap-northeast-1 |
| Target の outbound 認証 | `GATEWAY_IAM_ROLE` のみ |
| Gateway サービスロールの権限 | `bedrock-agentcore:InvokeWebSearch` on `arn:aws:bedrock-agentcore:<region>:aws:tool/web-search.v1` |
| ツール入力 | `query`（200文字以内）、`maxResults`（1〜25）、v1.2.0以降は `filters`（ドメイン・公開日） |
| CloudFormation | `AWS::BedrockAgentCore::GatewayTarget` の `TargetConfiguration.Mcp.Connector` で定義できる（バージョン指定は不可で、デフォルトバージョンになる） |
| Gateway の inbound 認証 | `CUSTOM_JWT` / `AWS_IAM` / `AUTHENTICATE_ONLY` / `NONE` |

## アーキテクチャ

認証方式ごとに Gateway を作る。既定では IAM 方式だけを作り、Cognito 方式と API Key 方式は `authModes` で追加する。Gateway 自体に固定費はなく、課金は呼び出し単位。

![構成図](images/architecture.png)

### 方式1: API Key（オプション、非推奨）

既定では作らない。Gateway を認証なしで公開するため、キー漏えいとゴミリクエストの課金リスクがあり、対策の WAF に固定費もかかる。AWS 認証情報を使えないクライアント向けの逃げ道として残している。


- `authorizerType: NONE` と REQUEST interceptor（Lambda）を組み合わせる。公式ドキュメントで「offloaded authorization」として紹介されている構成
- Interceptor は `passRequestHeaders: true` でヘッダーを受け取り、`Authorization: Bearer <key>` または `x-api-key: <key>` を Secrets Manager の値と定数時間で比較する
- 不一致なら `transformedGatewayResponse` で 401 と JSON-RPC エラーを返し、Target は呼ばれない
- キーは Secrets Manager の自動生成値を使う。カンマ区切りで複数キーを登録でき、クライアントごとにキーを分けたりローテーションしたりできる
- Lambda はシークレットを5分間キャッシュする
- URL とヘッダーを設定できるMCPクライアントなら追加ツールなしで繋がる

### 方式2: IAM（既定、推奨）

- `authorizerType: AWS_IAM`。呼び出し側に `bedrock-agentcore:InvokeGateway` が必要
- クライアントからは `uvx mcp-proxy-for-aws@latest <url> --service bedrock-agentcore --region <region>` を stdio MCP サーバーとして登録する
- シークレット管理が不要で、awsume 等で得た一時クレデンシャルをそのまま使える

### 方式3: Cognito（オプション、AWS アカウントを持たない利用者向け）

- `authorizerType: CUSTOM_JWT`。Cognito ユーザープールの OIDC discovery URL と、アプリクライアント ID（`allowedClients`）で検証する
- アプリクライアントはシークレットなしのパブリッククライアントで、認可コードフローと PKCE を使う。コールバックは `http://localhost:53280/callback`
- アクセストークンは既定で 1 時間、リフレッシュトークンは 7 日。クライアントの手元に長期のシークレットが残らない
- セルフサインアップは無効にして、管理者が招待する
- Gateway は 401 応答の `WWW-Authenticate` で `resource_metadata` を返し、`/.well-known/oauth-protected-resource` で Cognito を認可サーバーとして公開する。MCP クライアントは Cognito の OIDC メタデータからエンドポイントを見つける
- Cognito は動的クライアント登録に対応していないため、クライアント ID を事前に設定する（Claude Code は `--client-id` / `--callback-port`）
- 未認証のリクエストは Gateway の JWT 検証で弾かれ、Lambda は動かない。そのためレート制限用の WAF は付けない
- 実環境で確認したこと
  - Claude Code の `claude mcp login` でログインし、検索できた
  - Claude Code は PKCE（S256）と `resource` パラメータを付けて認可リクエストを送るが、Cognito は問題なく受け付けた。Cognito の OIDC メタデータには `code_challenge_methods_supported` がないが、Claude Code は拒否しなかった
  - JWT 認証のリクエストでは、リソースポリシーの `aws:SourceIp` 条件が使えない。`NotIpAddress` の Deny を付けると、許可リスト内の送信元も拒否された。IP 制限は WAF の IP セットで行う
- 未検証: 1 時間後のトークン自動更新、招待メールの仮パスワードから始まる初回ログイン、Claude Code 以外のクライアント

## CDK 構成

| ファイル | 役割 |
| --- | --- |
| `bin/app.ts` | エントリポイント。context で認証方式・除外ドメイン・レート制限・IP 制限・トークン有効期限などを受け取る |
| `lib/web-search-gateway-stack.ts` | 方式ごとの Gateway と Web Search Target、サービスロール、Gateway レート制限、IP 制限（リソースポリシー / WAF）、Cognito ユーザープール、Interceptor Lambda と Secret、WAF |
| `lambda/api-key-interceptor/index.ts` | API Key 検証 Interceptor |
| `scripts/smoke.ts` | デプロイ後のE2Eテスト（各方式で initialize → tools/list → tools/call、不正な認証情報の拒否） |
| `scripts/print-config.ts` | 各MCPクライアント向け設定スニペットの出力 |
| `scripts/lib.ts` | スタック出力の読み込み、API Key 取得、SigV4 署名付き fetch |

### context パラメータ

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `authModes` | `iam` | 作る Gateway の種類（`iam` / `cognito` / `apikey` をカンマ区切り）。Cognito 方式と API Key 方式は既定では作らない |
| `excludeDomains` | なし | 検索結果から除外するドメイン（カンマ区切り）。Target レベルで強制される |
| `enableWaf` | `true` | API Key 方式の Gateway に WAF を付けるか |
| `wafRequestsPer5MinPerIp` | `300` | WAF で許可する 1 IP あたりのリクエスト数（5分間） |
| `searchesPerMinute` | `60` | Gateway ごとの WebSearch 呼び出し上限（全クライアント合計） |
| `allowedIps` | なし | 許可する送信元 IP（IPv4 / IPv6 の CIDR）。IAM 方式はリソースポリシーの Deny（`NotIpAddress aws:SourceIp`）、API Key 方式は WAF の IP セット（IPv4 / IPv6 で別リソース）で制限する |
| `stackName` | `ManagedWebSearch` | スタック名 |

リージョンは `CDK_DEFAULT_REGION`（awsume のリージョン）を使い、未対応リージョンなら synth 時にエラーにする。

## セキュリティ上の考慮

- サービスロールの信頼ポリシーは `aws:SourceAccount` と `aws:SourceArn`（gateway/*）で絞る
- サービスロールに付ける権限は `InvokeWebSearch`（サービス所有ARN）と Interceptor Lambda の `InvokeFunction` だけ
- API Key 方式の Gateway URL は公開エンドポイントになる。キーが漏れたら Secrets Manager の値を更新すれば、最大5分で無効化される
- 利用規約上、検索結果を表示するときは出典URLを残す必要がある
- Connector の既定のツール説明は空なので、`Description` を設定し、LLM がいつ使うべきか判断できるようにする

### IP 制限

- IAM 方式: `AWS::BedrockAgentCore::ResourcePolicy` で `Principal: "*"` に Deny を付け、条件を `NotIpAddress aws:SourceIp` にする。明示的な Deny は identity ベースの許可より優先されるので、管理者も許可リスト外からは呼び出せない。追加料金なし
- API Key 方式: `NONE` 認証では IAM の評価に頼れないため、WAF の IP セットを使う。`enableWaf=false` でも `allowedIps` があれば Web ACL を作る
- 実環境で確認したこと（IAM 方式）: 許可リスト外の送信元からは SigV4 署名付きでも `-32002 Insufficient permissions` で拒否され、許可リスト内なら通った
- Gateway のエンドポイントは IPv4 のみ（AAAA レコードなし）。IPv6 の CIDR は将来のデュアルスタック対応に備えて受け付ける

### 攻撃とコストへの対策

`NONE` 認証の Gateway では、キーが誤っているリクエストも Gateway に届いた時点で課金される（Gateway API 呼び出し $0.005/1,000 件と Interceptor Lambda の実行料金）。拒否されたリクエストは Target に届かないので、Web Search の料金は発生しない。単価は小さいが上限がないため、次の2つを入れる。

| 対策 | 対象 | 効果 | コスト |
| --- | --- | --- | --- |
| AWS WAF の IP 単位レート制限（`AWS::WAFv2::WebACLAssociation` で関連付け） | API Key 方式（既定で有効、`enableWaf=false` で無効化） | Gateway より手前で遮断し、DDoS 時の単価を約 1/9 に下げる | Web ACL とルールで月 $6 程度、加えて $0.60/100 万リクエスト |
| Gateway のレート制限（`AWS::BedrockAgentCore::GatewayRateLimit`、`toolName` 単位） | 全方式 | WebSearch の呼び出し回数に上限をかけ、キー漏えい時も検索料金が青天井にならない | 追加料金なし |

Gateway の `WebAclArn` プロパティは読み取り専用なので、関連付けは `WebACLAssociation` リソースで行う。Gateway のレート制限は fail-open なので、これだけをセキュリティ境界にはしない。

## テスト方針

- ユニット: Interceptor のキー検証ロジック、CIDR の振り分け（vitest）
- スナップショットではなくアサーション: CDK テンプレートに必要なリソース・権限・設定があるか（vitest + `aws-cdk-lib/assertions`）
- E2E: `pnpm smoke` で、デプロイ済みの各 Gateway に MCP クライアントとして接続して検証する。Cognito 方式のログインは、`COGNITO_TEST_USERNAME` / `COGNITO_TEST_PASSWORD` を渡したときだけホスト型ログイン画面経由でトークンを取得して試す
