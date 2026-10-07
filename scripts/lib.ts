import { readFileSync } from "node:fs";
import { Sha256 } from "@aws-crypto/sha256-js";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

export interface StackOutputs {
  Region: string;
  ApiKeyGatewayUrl?: string;
  ApiKeySecretArn?: string;
  IamGatewayUrl?: string;
  IamGatewayInvokePolicyArn?: string;
}

// cdk-outputs.json があればそれを使い、なければ CloudFormation から取得する
export async function loadOutputs(stackName = process.env.STACK_NAME ?? "ManagedWebSearch"): Promise<StackOutputs> {
  try {
    return JSON.parse(readFileSync("cdk-outputs.json", "utf8"))[stackName];
  } catch {
    const res = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = res.Stacks?.[0]?.Outputs ?? [];
    return Object.fromEntries(outputs.map((o) => [o.OutputKey, o.OutputValue])) as unknown as StackOutputs;
  }
}

export async function getApiKey(outputs: StackOutputs): Promise<string> {
  const res = await new SecretsManagerClient({ region: outputs.Region }).send(
    new GetSecretValueCommand({ SecretId: outputs.ApiKeySecretArn }),
  );
  // 複数キーが登録されている場合は先頭を使う
  return (res.SecretString ?? "").split(",")[0].trim();
}

// IAM 認証の Gateway 向けに、リクエストごとに SigV4 署名する fetch
export function sigv4Fetch(region: string): typeof fetch {
  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region,
    credentials: fromNodeProviderChain(),
    sha256: Sha256,
  });
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers: Record<string, string> = { host: url.host };
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const signed = await signer.sign({
      method: init?.method ?? "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: init?.body as string | undefined,
    });
    return fetch(url, { ...init, headers: signed.headers });
  };
}
