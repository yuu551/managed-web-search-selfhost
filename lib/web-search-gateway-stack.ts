import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

export const SUPPORTED_REGIONS = ["us-east-1", "eu-west-1", "ap-northeast-1"];

export type AuthMode = "apikey" | "iam";

const TOOL_DESCRIPTION =
  "Search the web for up-to-date information such as recent news, releases, documentation, and facts after your training cutoff. " +
  "Returns relevant text snippets with URL, title, and published date. Always cite the source URLs in your answer.";

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
}

export class WebSearchGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebSearchGatewayStackProps) {
    super(scope, id, props);

    if (!cdk.Token.isUnresolved(this.region) && !SUPPORTED_REGIONS.includes(this.region)) {
      throw new Error(`Web Search Tool is not available in ${this.region}. Use one of: ${SUPPORTED_REGIONS.join(", ")}`);
    }
    if (props.authModes.length === 0) {
      throw new Error("authModes must contain at least one of: apikey, iam");
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

      if (props.enableWaf ?? true) {
        const webAcl = new wafv2.CfnWebACL(this, "ApiKeyGatewayWebAcl", {
          scope: "REGIONAL",
          defaultAction: { allow: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${this.stackName}-apikey-gateway`,
            sampledRequestsEnabled: true,
          },
          rules: [
            {
              name: "RateLimitPerIp",
              priority: 0,
              action: { block: {} },
              statement: {
                rateBasedStatement: {
                  aggregateKeyType: "IP",
                  evaluationWindowSec: 300,
                  limit: props.wafRequestsPer5MinPerIp ?? 300,
                },
              },
              visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: "RateLimitPerIp",
                sampledRequestsEnabled: true,
              },
            },
          ],
        });
        new wafv2.CfnWebACLAssociation(this, "ApiKeyGatewayWebAclAssociation", {
          resourceArn: gateway.attrGatewayArn,
          webAclArn: webAcl.attrArn,
        });
      }

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

    new cdk.CfnOutput(this, "Region", { value: this.region });
  }
}
