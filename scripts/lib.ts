import { createHash, randomBytes } from "node:crypto";
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
  CognitoGatewayUrl?: string;
  CognitoClientId?: string;
  CognitoDomain?: string;
  CognitoUserPoolId?: string;
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

/**
 * テスト用: Cognito のホスト型ログイン画面にフォーム POST して、PKCE 付き認可コードフローでアクセストークンを得る。
 * 実際のクライアントはブラウザでログインする。ここではログイン画面の HTML 構造に依存するので E2E テスト専用
 */
export async function getCognitoAccessToken(
  outputs: StackOutputs,
  username: string,
  password: string,
  redirectUri = "http://localhost:53280/callback",
): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const cookies = new Map<string, string>();
  const send = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers as Record<string, string>), cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  };

  const authorize = new URL(`${outputs.CognitoDomain}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: outputs.CognitoClientId!,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    scope: "openid email profile",
  }).toString();
  const loginUrl = (await send(authorize.toString())).headers.get("location")!;
  const page = await (await send(loginUrl)).text();
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("Could not find the CSRF token on the Cognito login page");

  const login = await send(loginUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, username, password, cognitoAsfData: "" }),
  });
  const code = new URL(login.headers.get("location") ?? "http://invalid/").searchParams.get("code");
  if (!code) throw new Error("Cognito login failed (check the username / password)");

  const token = await fetch(`${outputs.CognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: outputs.CognitoClientId!,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const json = (await token.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`Token exchange failed: ${json.error}`);
  return json.access_token;
}
