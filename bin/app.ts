#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AuthMode, WebSearchGatewayStack } from "../lib/web-search-gateway-stack";

const app = new cdk.App();

const csv = (v: unknown): string[] =>
  typeof v === "string"
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

const num = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v));

const authModes = csv(app.node.tryGetContext("authModes") ?? "iam");
const invalid = authModes.filter((m) => !["apikey", "iam", "cognito"].includes(m));
if (invalid.length) throw new Error(`Unknown authModes: ${invalid.join(", ")} (use apikey, iam, cognito)`);

new WebSearchGatewayStack(app, app.node.tryGetContext("stackName") ?? "ManagedWebSearch", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  authModes: authModes as AuthMode[],
  excludeDomains: csv(app.node.tryGetContext("excludeDomains")),
  enableWaf: String(app.node.tryGetContext("enableWaf") ?? "true") !== "false",
  wafRequestsPer5MinPerIp: num(app.node.tryGetContext("wafRequestsPer5MinPerIp")),
  searchesPerMinute: num(app.node.tryGetContext("searchesPerMinute")),
  allowedIps: csv(app.node.tryGetContext("allowedIps")),
  oauthCallbackUrls: csv(app.node.tryGetContext("oauthCallbackUrls")),
  accessTokenValidityMinutes: num(app.node.tryGetContext("accessTokenValidityMinutes")),
  refreshTokenValidityDays: num(app.node.tryGetContext("refreshTokenValidityDays")),
});
