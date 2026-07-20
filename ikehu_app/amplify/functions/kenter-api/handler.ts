import { createHash, createHmac } from 'node:crypto';

type LambdaEvent = {
  rawPath?: string;
  path?: string;
  rawQueryString?: string;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: {
      method?: string;
    };
  };
};

type LambdaResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

type FetchLike = typeof fetch;

const KENTER_AUTH_URL = 'https://login.kenter.nu/connect/token';
const KENTER_API_BASE_URL = 'https://api.kenter.nu';
const METERS_PATH = '/meetdata/v2/meters?updates_days=0';
const METERS_CACHE_KEY = 'kenter/meters/latest.json';

let cachedToken: { accessToken: string; expiresAt: number } | undefined;

export function clearTokenCacheForTests(): void {
  cachedToken = undefined;
}

type KenterResult = {
  status: number;
  ok: boolean;
  data: unknown;
};

type MeterCacheEntry = {
  fetchedAt: string;
  response: KenterResult;
};

type MeterStore = {
  get(): Promise<MeterCacheEntry | undefined>;
  put(entry: MeterCacheEntry): Promise<void>;
};

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

export function parseJsonBody(body?: string, isBase64Encoded = false): Record<string, unknown> {
  if (!body) {
    return {};
  }

  const decoded = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  const parsed = JSON.parse(decoded);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
}

export function isAllowedMeasurementPath(path: string): boolean {
  if (!path.startsWith('/')) {
    return false;
  }

  if (path.startsWith('//')) {
    return false;
  }

  try {
    new URL(path);
    return false;
  } catch {
    return path.startsWith('/meetdata/v2/measurements/');
  }
}

function hasKenterConfig(): boolean {
  return Boolean(process.env.KENTER_CLIENT_ID && process.env.KENTER_CLIENT_SECRET);
}

async function getAccessToken(fetchImpl: FetchLike): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.accessToken;
  }

  if (!hasKenterConfig()) {
    throw new Error('Kenter credentials are not configured.');
  }

  const body = new URLSearchParams({
    client_id: process.env.KENTER_CLIENT_ID ?? '',
    client_secret: process.env.KENTER_CLIENT_SECRET ?? '',
    grant_type: 'client_credentials',
    scope: 'meetdata.read',
  });

  const response = await fetchImpl(KENTER_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const tokenBody = await response.json().catch(() => ({}));
  if (!response.ok || typeof tokenBody.access_token !== 'string') {
    throw new Error(`Kenter token request failed with status ${response.status}.`);
  }

  const expiresIn = typeof tokenBody.expires_in === 'number' ? tokenBody.expires_in : 3600;
  cachedToken = {
    accessToken: tokenBody.access_token,
    expiresAt: now + expiresIn * 1000,
  };

  return cachedToken.accessToken;
}

async function fetchKenterPath(fetchImpl: FetchLike, path: string): Promise<KenterResult> {
  const token = await getAccessToken(fetchImpl);
  const response = await fetchImpl(`${KENTER_API_BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  const responseText = await response.text();
  let data: unknown = responseText;

  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = responseText;
  }

  return {
    status: response.status,
    ok: response.ok,
    data,
  };
}

function toHex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

async function s3Request(
  fetchImpl: FetchLike,
  method: 'GET' | 'PUT',
  bucket: string,
  region: string,
  key: string,
  body = '',
): Promise<Response> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credentials are not available for S3 cache access.');
  }

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const payloadHash = toHex(body);
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  if (method === 'PUT') {
    headers['content-type'] = 'application/json';
  }

  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken;
  }

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((header) => `${header}:${headers[header]}\n`)
    .join('');
  const canonicalRequest = [
    method,
    `/${encodedKey}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    toHex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', getSigningKey(secretAccessKey, dateStamp, region))
    .update(stringToSign)
    .digest('hex');

  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return fetchImpl(`https://${host}/${encodedKey}`, {
    method,
    headers,
    body: method === 'PUT' ? body : undefined,
  });
}

function createS3MeterStore(fetchImpl: FetchLike): MeterStore | undefined {
  const bucket = process.env.KENTER_CACHE_BUCKET;
  const region = process.env.KENTER_CACHE_REGION || process.env.AWS_REGION || 'eu-central-1';

  if (!bucket) {
    return undefined;
  }

  return {
    async get() {
      const response = await s3Request(fetchImpl, 'GET', bucket, region, METERS_CACHE_KEY);

      if (response.status === 404 || response.status === 403) {
        return undefined;
      }

      if (!response.ok) {
        throw new Error(`S3 meter cache read failed with status ${response.status}.`);
      }

      return (await response.json()) as MeterCacheEntry;
    },
    async put(entry) {
      const response = await s3Request(
        fetchImpl,
        'PUT',
        bucket,
        region,
        METERS_CACHE_KEY,
        JSON.stringify(entry),
      );

      if (!response.ok) {
        throw new Error(`S3 meter cache write failed with status ${response.status}.`);
      }
    },
  };
}

function isFresh(entry: MeterCacheEntry): boolean {
  const ttlSeconds = Number(process.env.KENTER_METERS_CACHE_TTL_SECONDS || 86_400);
  const fetchedAt = Date.parse(entry.fetchedAt);

  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ttlSeconds * 1000;
}

async function getMeters(fetchImpl: FetchLike, store: MeterStore | undefined, forceRefresh: boolean) {
  if (store && !forceRefresh) {
    const cached = await store.get();

    if (cached && isFresh(cached)) {
      return jsonResponse(cached.response.status, {
        ...cached.response,
        cache: {
          hit: true,
          fetchedAt: cached.fetchedAt,
        },
      });
    }
  }

  const response = await fetchKenterPath(fetchImpl, METERS_PATH);
  const fetchedAt = new Date().toISOString();

  if (store && response.ok) {
    await store.put({ fetchedAt, response });
  }

  return jsonResponse(response.status, {
    ...response,
    cache: {
      hit: false,
      stored: Boolean(store && response.ok),
      fetchedAt,
    },
  });
}

export function createHandler(fetchImpl: FetchLike = fetch, meterStore = createS3MeterStore(fetchImpl)) {
  return async function route(event: LambdaEvent): Promise<LambdaResponse> {
    const method = event.requestContext?.http?.method ?? 'GET';
    const path = event.rawPath ?? event.path ?? '/';
    const query = new URLSearchParams(event.rawQueryString || '');

    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: {}, body: '' };
    }

    try {
      if (method === 'GET' && path === '/health') {
        return jsonResponse(200, {
          ok: true,
          configured: hasKenterConfig(),
          service: 'kenter-api',
        });
      }

      if (method === 'GET' && path === '/meters') {
        return getMeters(fetchImpl, meterStore, query.get('refresh') === 'true');
      }

      if (method === 'GET' && path === '/meters/refresh') {
        return getMeters(fetchImpl, meterStore, true);
      }

      if (method === 'GET' && path === '/modified') {
        const response = await fetchKenterPath(fetchImpl, '/meetdata/v2/measurements/modified');
        return jsonResponse(response.status, response);
      }

      if (method === 'POST' && path === '/fetch-url') {
        const body = parseJsonBody(event.body, event.isBase64Encoded);
        const targetUrl = typeof body.url === 'string' ? body.url : '';

        if (!isAllowedMeasurementPath(targetUrl)) {
          return jsonResponse(400, {
            error: 'Only relative measurement URLs under /meetdata/v2/measurements/ are allowed.',
          });
        }

        const response = await fetchKenterPath(fetchImpl, targetUrl);
        return jsonResponse(response.status, response);
      }

      return jsonResponse(404, { error: `No route for ${method} ${path}.` });
    } catch (error) {
      return jsonResponse(500, {
        error: error instanceof Error ? error.message : 'Unexpected Lambda error.',
      });
    }
  };
}

export const handler = createHandler();
