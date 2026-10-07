import { isIPv4, isIPv6 } from "node:net";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

export const SUPPORTED_REGIONS = ["us-east-1", "eu-west-1", "ap-northeast-1"];

export type AuthMode = "apikey" | "iam" | "cognito";

const TOOL_DESCRIPTION =
  "Search the web for up-to-date information such as recent news, releases, documentation, and facts after your training cutoff. " +
  "Returns relevant text snippets with URL, title, and published date. Always cite the source URLs in your answer.";

/** CIDR（プレフィックス省略時は単一アドレス）を IPv4 / IPv6 に振り分け、/32・/128 を補う */
export function classifyCidrs(cidrs: string[]): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const raw of cidrs) {
    const [addr, prefix, ...rest] = raw.trim().split("/");
    const bits = prefix === undefined ? undefined : Number(prefix);
    const validPrefix = (max: number) => bits === undefined || (Number.isInteger(bits) && bits >= 0 && bits <= max);
    if (rest.length === 0 && isIPv4(addr) && validPrefix(32)) ipv4.push(`${addr}/${bits ?? 32}`);
    else if (rest.length === 0 && isIPv6(addr) && validPrefix(128)) ipv6.push(`${addr}/${bits ?? 128}`);
    else throw new Error(`Invalid CIDR in allowedIps: ${raw}`);
  }
  return { ipv4, ipv6 };
}

export interface WebSearchGatewayStackProps extends cdk.StackProps {
  authModes: AuthMode[];
  /** 検索結果から常に除外するドメイン（Target レベルで強制され、クライアントからは見えない） */
  excludeDomains?: string[];
  /**
   * API Key 方式の Gateway に WAF（IP 単位のレート制限）を付けるか。
   * NONE 認証の Gateway は拒否するリクエストにも Gateway / Lambda の料金がかかるため、既定で有効にする
   * @default true
   */
  enableWaf?: boolean;
  /** WAF で許可する 1 IP あたりのリクエスト数（5 分間） @default 300 */
  wafRequestsPer5MinPerIp?: number;
  /** Gateway ごとの WebSearch 呼び出し上限（1 分あたり、全クライアント合計） @default 60 */
  searchesPerMinute?: number;
  /**
   * 接続を許可する送信元 IP（IPv4 / IPv6 の CIDR を混在可）。未指定なら制限しない。
   * IAM 方式は Gateway のリソースポリシー（追加料金なし）、API Key 方式と Cognito 方式は WAF の IP セットで制限する
   */
  allowedIps?: string[];
  /** Cognito 方式の OAuth コールバック URL（MCP クライアントが待ち受ける localhost の URL） @default ["http://localhost:53280/callback"] */
  oauthCallbackUrls?: string[];
  /** Cognito 方式のアクセストークンの有効期限（分、5〜1440） @default 60 */
  accessTokenValidityMinutes?: number;
  /** Cognito 方式のリフレッシュトークンの有効期限（日）。切れると再ログインになる @default 7 */
  refreshTokenValidityDays?: number;
}

export class WebSearchGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebSearchGatewayStackProps) {
    super(scope, id, props);

    if (!cdk.Token.isUnresolved(this.region) && !SUPPORTED_REGIONS.includes(this.region)) {
      throw new Error(`Web Search Tool is not available in ${this.region}. Use one of: ${SUPPORTED_REGIONS.join(", ")}`);
    }
    if (props.authModes.length === 0) {
      throw new Error("authModes must contain at least one of: apikey, iam, cognito");
    }

    const role = new iam.Role(this, "GatewayServiceRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:gateway/*` },
        },
      }),
      description: "Service role for AgentCore Gateway with Web Search Tool",
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeWebSearch"],
        resources: [`arn:${this.partition}:bedrock-agentcore:${this.region}:aws:tool/web-search.v1`],
      }),
    );

    const allowed = classifyCidrs(props.allowedIps ?? []);
    const allowedCidrs = [...allowed.ipv4, ...allowed.ipv6];

    // 明示的な Deny は呼び出し元の権限（管理者を含む）より優先されるため、許可リスト外からは誰も呼び出せない
    const restrictBySourceIp = (gateway: agentcore.CfnGateway, idPrefix: string) => {
      if (allowedCidrs.length === 0) return;
      new agentcore.CfnResourcePolicy(this, `${idPrefix}GatewayResourcePolicy`, {
        resourceArn: gateway.attrGatewayArn,
        policy: cdk.Stack.of(this).toJsonString({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "DenyNotAllowedIps",
              Effect: "Deny",
              Principal: "*",
              Action: "bedrock-agentcore:InvokeGateway",
              Resource: gateway.attrGatewayArn,
              Condition: { NotIpAddress: { "aws:SourceIp": allowedCidrs } },
            },
          ],
        }),
      });
    };

    // WAF は Gateway より手前で遮断できる。IP 制限（許可リスト外をブロック）と IP 単位のレート制限を必要な分だけ付ける
    const attachWaf = (gateway: agentcore.CfnGateway, idPrefix: string, opts: { rateLimit: boolean }) => {
      const rules: wafv2.CfnWebACL.RuleProperty[] = [];
      const visibility = (metricName: string) => ({ cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true });

      if (allowedCidrs.length > 0) {
        // IP セットは IPv4 と IPv6 で別リソースになる
        const ipSetRefs = (["IPV4", "IPV6"] as const)
          .map((version) => ({ version, addresses: version === "IPV4" ? allowed.ipv4 : allowed.ipv6 }))
          .filter((x) => x.addresses.length > 0)
          .map(({ version, addresses }) => ({
            ipSetReferenceStatement: {
              arn: new wafv2.CfnIPSet(this, `${idPrefix}GatewayAllowed${version}`, {
                scope: "REGIONAL",
                ipAddressVersion: version,
                addresses,
              }).attrArn,
            },
          }));
        rules.push({
          name: "BlockNotAllowedIps",
          priority: 0,
          action: { block: {} },
          statement: {
            notStatement: {
              statement: ipSetRefs.length === 1 ? ipSetRefs[0] : { orStatement: { statements: ipSetRefs } },
            },
          },
          visibilityConfig: visibility("BlockNotAllowedIps"),
        });
      }
      if (opts.rateLimit) {
        rules.push({
          name: "RateLimitPerIp",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: "IP",
              evaluationWindowSec: 300,
              limit: props.wafRequestsPer5MinPerIp ?? 300,
            },
          },
          visibilityConfig: visibility("RateLimitPerIp"),
        });
      }
      if (rules.length === 0) return;

      const webAcl = new wafv2.CfnWebACL(this, `${idPrefix}GatewayWebAcl`, {
        scope: "REGIONAL",
        defaultAction: { allow: {} },
        visibilityConfig: visibility(`${this.stackName}-${idPrefix.toLowerCase()}-gateway`),
        rules,
      });
      new wafv2.CfnWebACLAssociation(this, `${idPrefix}GatewayWebAclAssociation`, {
        resourceArn: gateway.attrGatewayArn,
        webAclArn: webAcl.attrArn,
      });
    };

    const parameterValues = props.excludeDomains?.length ? { domainFilter: { exclude: props.excludeDomains } } : {};

    const addWebSearchTarget = (gateway: agentcore.CfnGateway, idPrefix: string) => {
      const target = new agentcore.CfnGatewayTarget(this, `${idPrefix}WebSearchTarget`, {
        gatewayIdentifier: gateway.attrGatewayIdentifier,
        name: "web-search",
        description: "Amazon Bedrock AgentCore managed Web Search Tool",
        targetConfiguration: {
          mcp: {
            connector: {
              source: { connectorId: "web-search" },
              configurations: [
                {
                  name: "WebSearch",
                  // 既定では description が空で、クライアントの LLM がいつ使うべきか判断しにくいため明示する
                  description: TOOL_DESCRIPTION,
                  parameterValues,
                },
              ],
            },
          },
        },
        credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      });
      // Target 作成時に Gateway がロールで検証するため、ポリシーを先に作る
      target.node.addDependency(role);

      // 検索回数の上限。キーが漏れたり暴走したクライアントがいても Web Search の料金が青天井にならないようにする
      const rateLimit = new agentcore.CfnGatewayRateLimit(this, `${idPrefix}SearchRateLimit`, {
        gatewayIdentifier: gateway.attrGatewayIdentifier,
        description: "Caps WebSearch tool calls across all callers",
        dimensionKeys: ["toolName"],
        entries: [
          {
            dimensions: { toolName: `${target.name}___WebSearch` },
            requests: [{ rate: props.searchesPerMinute ?? 60, period: "minute" }],
          },
        ],
      });
      rateLimit.addResourceDependency(target);
      return target;
    };

    if (props.authModes.includes("apikey")) {
      const secret = new secretsmanager.Secret(this, "ApiKeySecret", {
        description: "API keys for the Web Search MCP gateway (comma-separated for multiple keys)",
        generateSecretString: { passwordLength: 48, excludePunctuation: true, includeSpace: false },
      });

      const interceptor = new nodejs.NodejsFunction(this, "ApiKeyInterceptor", {
        entry: path.join(__dirname, "../lambda/api-key-interceptor/index.ts"),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        environment: { API_KEY_SECRET_ARN: secret.secretArn },
        logGroup: new logs.LogGroup(this, "ApiKeyInterceptorLogs", {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        bundling: { minify: true, target: "node24" },
      });
      secret.grantRead(interceptor);
      interceptor.grantInvoke(role);

      const gateway = new agentcore.CfnGateway(this, "ApiKeyGateway", {
        name: `${this.stackName}-apikey`.toLowerCase(),
        description: "Web Search MCP gateway (API key auth via interceptor)",
        protocolType: "MCP",
        // 認証は interceptor に委譲する（offloaded authorization）
        authorizerType: "NONE",
        roleArn: role.roleArn,
        interceptorConfigurations: [
          {
            interceptor: { lambda: { arn: interceptor.functionArn } },
            interceptionPoints: ["REQUEST"],
            inputConfiguration: { passRequestHeaders: true },
          },
        ],
      });
      gateway.node.addDependency(role);
      addWebSearchTarget(gateway, "ApiKey");

      attachWaf(gateway, "ApiKey", { rateLimit: props.enableWaf ?? true });

      new cdk.CfnOutput(this, "ApiKeyGatewayUrl", { value: gateway.attrGatewayUrl });
      new cdk.CfnOutput(this, "ApiKeySecretArn", { value: secret.secretArn });
    }

    if (props.authModes.includes("iam")) {
      const gateway = new agentcore.CfnGateway(this, "IamGateway", {
        name: `${this.stackName}-iam`.toLowerCase(),
        description: "Web Search MCP gateway (AWS IAM / SigV4 auth)",
        protocolType: "MCP",
        authorizerType: "AWS_IAM",
        roleArn: role.roleArn,
      });
      gateway.node.addDependency(role);
      addWebSearchTarget(gateway, "Iam");

      restrictBySourceIp(gateway, "Iam");

      // 呼び出し側に付与するためのポリシー（ユーザーやロールにアタッチして使う）
      const invokePolicy = new iam.ManagedPolicy(this, "IamGatewayInvokePolicy", {
        description: "Allows invoking the Web Search MCP gateway",
        statements: [
          new iam.PolicyStatement({
            actions: ["bedrock-agentcore:InvokeGateway"],
            resources: [gateway.attrGatewayArn],
          }),
        ],
      });

      new cdk.CfnOutput(this, "IamGatewayUrl", { value: gateway.attrGatewayUrl });
      new cdk.CfnOutput(this, "IamGatewayInvokePolicyArn", { value: invokePolicy.managedPolicyArn });
    }

    if (props.authModes.includes("cognito")) {
      const userPool = new cognito.UserPool(this, "UserPool", {
        // 利用者は管理者が招待する。セルフサインアップを開けると誰でも検索できてしまう
        selfSignUpEnabled: false,
        signInAliases: { email: true },
        mfa: cognito.Mfa.OPTIONAL,
        mfaSecondFactor: { otp: true, sms: false },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const domain = userPool.addDomain("Domain", {
        cognitoDomain: { domainPrefix: `${this.stackName.toLowerCase()}-${this.account}` },
      });
      // パブリッククライアント（シークレットなし）+ 認可コードフロー + PKCE。MCP クライアントの手元に長期のシークレットを置かない
      const client = userPool.addClient("McpClient", {
        generateSecret: false,
        authFlows: {},
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
          callbackUrls: props.oauthCallbackUrls?.length ? props.oauthCallbackUrls : ["http://localhost:53280/callback"],
        },
        accessTokenValidity: cdk.Duration.minutes(props.accessTokenValidityMinutes ?? 60),
        idTokenValidity: cdk.Duration.minutes(props.accessTokenValidityMinutes ?? 60),
        refreshTokenValidity: cdk.Duration.days(props.refreshTokenValidityDays ?? 7),
        preventUserExistenceErrors: true,
        enableTokenRevocation: true,
      });

      const gateway = new agentcore.CfnGateway(this, "CognitoGateway", {
        name: `${this.stackName}-cognito`.toLowerCase(),
        description: "Web Search MCP gateway (Cognito OAuth / short-lived JWT)",
        protocolType: "MCP",
        authorizerType: "CUSTOM_JWT",
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`,
            allowedClients: [client.userPoolClientId],
          },
        },
        roleArn: role.roleArn,
      });
      gateway.node.addDependency(role);
      addWebSearchTarget(gateway, "Cognito");
      // JWT 認証のリクエストではリソースポリシーの aws:SourceIp が評価に使えず全拒否になる（実環境で確認）ため、IP 制限は WAF で行う。
      // 未認証のリクエストは Gateway の JWT 検証で弾かれるので、レート制限用の WAF は付けない
      attachWaf(gateway, "Cognito", { rateLimit: false });

      new cdk.CfnOutput(this, "CognitoGatewayUrl", { value: gateway.attrGatewayUrl });
      new cdk.CfnOutput(this, "CognitoUserPoolId", { value: userPool.userPoolId });
      new cdk.CfnOutput(this, "CognitoClientId", { value: client.userPoolClientId });
      new cdk.CfnOutput(this, "CognitoDomain", { value: domain.baseUrl() });
    }

    new cdk.CfnOutput(this, "Region", { value: this.region });
  }
}
