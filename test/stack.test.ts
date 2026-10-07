import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { classifyCidrs, WebSearchGatewayStack, WebSearchGatewayStackProps } from "../lib/web-search-gateway-stack";

const synth = (props: Partial<WebSearchGatewayStackProps> = {}, region = "us-east-1") => {
  const app = new cdk.App();
  const stack = new WebSearchGatewayStack(app, "TestStack", {
    env: { account: "123456789012", region },
    authModes: ["apikey", "iam"],
    ...props,
  });
  return Template.fromStack(stack);
};

describe("WebSearchGatewayStack", () => {
  it("creates an API key gateway with a header-passing REQUEST interceptor and an IAM gateway", () => {
    const t = synth();
    t.resourceCountIs("AWS::BedrockAgentCore::Gateway", 2);
    t.hasResourceProperties("AWS::BedrockAgentCore::Gateway", {
      Name: "teststack-apikey",
      AuthorizerType: "NONE",
      ProtocolType: "MCP",
      InterceptorConfigurations: [
        {
          InterceptionPoints: ["REQUEST"],
          InputConfiguration: { PassRequestHeaders: true },
          Interceptor: { Lambda: { Arn: Match.anyValue() } },
        },
      ],
    });
    t.hasResourceProperties("AWS::BedrockAgentCore::Gateway", {
      Name: "teststack-iam",
      AuthorizerType: "AWS_IAM",
    });
  });

  it("attaches the web-search connector target to each gateway", () => {
    const t = synth();
    t.resourceCountIs("AWS::BedrockAgentCore::GatewayTarget", 2);
    t.hasResourceProperties("AWS::BedrockAgentCore::GatewayTarget", {
      TargetConfiguration: {
        Mcp: {
          Connector: {
            Source: { ConnectorId: "web-search" },
            Configurations: [{ Name: "WebSearch", Description: Match.stringLikeRegexp("cite"), ParameterValues: {} }],
          },
        },
      },
      CredentialProviderConfigurations: [{ CredentialProviderType: "GATEWAY_IAM_ROLE" }],
    });
  });

  it("scopes the service role trust policy and grants InvokeWebSearch on the service-owned tool ARN", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            Condition: {
              StringEquals: { "aws:SourceAccount": "123456789012" },
              ArnLike: { "aws:SourceArn": Match.anyValue() },
            },
          }),
        ],
      },
    });
    const roles = JSON.stringify(t.findResources("AWS::IAM::Role"));
    expect(roles).toContain(":bedrock-agentcore:us-east-1:123456789012:gateway/*");
    const policies = JSON.stringify(t.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("bedrock-agentcore:InvokeWebSearch");
    expect(policies).toContain(":bedrock-agentcore:us-east-1:aws:tool/web-search.v1");
    expect(policies).toContain("lambda:InvokeFunction");
  });

  it("applies excludeDomains as a target-level domain filter", () => {
    const t = synth({ excludeDomains: ["example.com"] });
    t.hasResourceProperties("AWS::BedrockAgentCore::GatewayTarget", {
      TargetConfiguration: {
        Mcp: { Connector: { Configurations: [{ Name: "WebSearch", Description: Match.anyValue(), ParameterValues: { domainFilter: { exclude: ["example.com"] } } }] } },
      },
    });
  });

  it("creates only the IAM gateway when authModes is iam", () => {
    const t = synth({ authModes: ["iam"] });
    t.resourceCountIs("AWS::BedrockAgentCore::Gateway", 1);
    t.resourceCountIs("AWS::Lambda::Function", 0);
    t.resourceCountIs("AWS::SecretsManager::Secret", 0);
  });

  it("protects the API key gateway with a per-IP WAF rate rule by default", () => {
    const t = synth();
    t.hasResourceProperties("AWS::WAFv2::WebACL", {
      Scope: "REGIONAL",
      Rules: [Match.objectLike({ Statement: { RateBasedStatement: Match.objectLike({ AggregateKeyType: "IP", Limit: 300 }) } })],
    });
    t.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
    expect(synth({ enableWaf: false }).findResources("AWS::WAFv2::WebACL")).toEqual({});
  });

  it("caps WebSearch calls per gateway with a rate limit", () => {
    const t = synth({ searchesPerMinute: 30 });
    t.resourceCountIs("AWS::BedrockAgentCore::GatewayRateLimit", 2);
    t.hasResourceProperties("AWS::BedrockAgentCore::GatewayRateLimit", {
      DimensionKeys: ["toolName"],
      Entries: [{ Dimensions: { toolName: "web-search___WebSearch" }, Requests: [{ Rate: 30, Period: "minute" }] }],
    });
  });

  it("classifies IPv4 / IPv6 CIDRs and rejects invalid entries", () => {
    expect(classifyCidrs(["203.0.113.10", "198.51.100.0/24", "2001:db8::1", "2001:db8::/32"])).toEqual({
      ipv4: ["203.0.113.10/32", "198.51.100.0/24"],
      ipv6: ["2001:db8::1/128", "2001:db8::/32"],
    });
    for (const bad of ["10.0.0.0/33", "2001:db8::/129", "example.com", "10.0.0.0/8/1", "10.0.0.0/x"]) {
      expect(() => classifyCidrs([bad])).toThrow(/Invalid CIDR/);
    }
  });

  it("restricts the IAM gateway by source IP with a Deny resource policy", () => {
    const t = synth({ authModes: ["iam"], allowedIps: ["203.0.113.0/24", "2001:db8::/32"] });
    const [policy] = Object.values(t.findResources("AWS::BedrockAgentCore::ResourcePolicy"));
    const doc = JSON.stringify(policy.Properties.Policy);
    expect(doc).toContain('\\"Effect\\":\\"Deny\\"');
    expect(doc).toContain("NotIpAddress");
    expect(doc).toContain("203.0.113.0/24");
    expect(doc).toContain("2001:db8::/32");
    expect(synth({ authModes: ["iam"] }).findResources("AWS::BedrockAgentCore::ResourcePolicy")).toEqual({});
  });

  it("restricts the API key gateway with WAF IP sets for IPv4 and IPv6", () => {
    const t = synth({ authModes: ["apikey"], allowedIps: ["203.0.113.0/24", "2001:db8::/32"] });
    t.hasResourceProperties("AWS::WAFv2::IPSet", { IPAddressVersion: "IPV4", Addresses: ["203.0.113.0/24"] });
    t.hasResourceProperties("AWS::WAFv2::IPSet", { IPAddressVersion: "IPV6", Addresses: ["2001:db8::/32"] });
    t.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: "BlockNotAllowedIps",
          Statement: { NotStatement: { Statement: { OrStatement: { Statements: [Match.anyValue(), Match.anyValue()] } } } },
        }),
      ]),
    });
  });

  it("still creates a WAF for IP restriction when enableWaf is false", () => {
    const t = synth({ authModes: ["apikey"], enableWaf: false, allowedIps: ["203.0.113.10"] });
    t.resourceCountIs("AWS::WAFv2::IPSet", 1);
    t.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: [Match.objectLike({ Name: "BlockNotAllowedIps", Statement: { NotStatement: { Statement: { IPSetReferenceStatement: Match.anyValue() } } } })],
    });
  });

  it("rejects unsupported regions", () => {
    expect(() => synth({}, "us-west-2")).toThrow(/not available in us-west-2/);
  });
});
