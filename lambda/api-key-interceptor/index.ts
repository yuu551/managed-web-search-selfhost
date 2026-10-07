import { timingSafeEqual } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

// AgentCore Gateway REQUEST interceptor (MCP target) の入出力のうち、使う部分だけを定義する
export interface InterceptorEvent {
  interceptorInputVersion: string;
  mcp?: {
    gatewayRequest?: {
      headers?: Record<string, string | undefined>;
      body?: { jsonrpc?: string; id?: string | number | null; method?: string; [k: string]: unknown };
    };
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const sm = new SecretsManagerClient({});
let cache: { keys: string[]; expiresAt: number } | undefined;

async function loadKeys(): Promise<string[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.keys;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.API_KEY_SECRET_ARN }));
  const keys = parseKeys(res.SecretString ?? "");
  cache = { keys, expiresAt: Date.now() + CACHE_TTL_MS };
  return keys;
}

// シークレットはカンマ区切りで複数キーを持てる（クライアント別の発行やローテーション用）
export function parseKeys(secret: string): string[] {
  return secret
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

// Authorization: Bearer <key> を優先し、なければ x-api-key を見る
export function extractKey(headers: Record<string, string | undefined> = {}): string | undefined {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const bearer = lower["authorization"]?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || lower["x-api-key"]?.trim() || undefined;
}

export function isValidKey(candidate: string | undefined, keys: string[]): boolean {
  if (!candidate) return false;
  const c = Buffer.from(candidate);
  // 早期 return せず全キーと比較して、どのキーに一致したかを応答時間から推測されないようにする
  let ok = false;
  for (const k of keys) {
    const b = Buffer.from(k);
    if (b.length === c.length && timingSafeEqual(b, c)) ok = true;
  }
  return ok;
}

export async function handler(event: InterceptorEvent) {
  const req = event.mcp?.gatewayRequest;
  const body = req?.body ?? {};

  if (isValidKey(extractKey(req?.headers), await loadKeys())) {
    return {
      interceptorOutputVersion: "1.0",
      mcp: { transformedGatewayRequest: { body } },
    };
  }

  console.warn(JSON.stringify({ message: "rejected request", method: body.method }));
  return {
    interceptorOutputVersion: "1.0",
    mcp: {
      transformedGatewayResponse: {
        statusCode: 401,
        body: {
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32001, message: "Unauthorized: missing or invalid API key" },
        },
      },
    },
  };
}
