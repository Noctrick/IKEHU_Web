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

type UsageMonthEntry = {
  connectionId: string;
  meteringPointId: string;
  year: number;
  month: number;
  sourcePath: string;
  kenterStatus: number;
  hasQuarterHourData: boolean;
  resolutions: string[];
  rawResponse: unknown;
};

type UsageStore = {
  putUsageMonth(entry: UsageMonthEntry): Promise<void>;
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

function getSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
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
  const signature = createHmac('sha256', getSigningKey(secretAccessKey, dateStamp, region, 's3'))
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

async function dynamoRequest(
  fetchImpl: FetchLike,
  region: string,
  target: string,
  body: string,
): Promise<Response> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credentials are not available for DynamoDB access.');
  }

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = `dynamodb.${region}.amazonaws.com`;
  const payloadHash = toHex(body);
  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.0',
    host,
    'x-amz-date': amzDate,
    'x-amz-target': target,
  };

  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken;
  }

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((header) => `${header}:${headers[header]}\n`)
    .join('');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/dynamodb/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    toHex(canonicalRequest),
  ].join('\n');
  const signature = createHmac(
    'sha256',
    getSigningKey(secretAccessKey, dateStamp, region, 'dynamodb'),
  )
    .update(stringToSign)
    .digest('hex');

  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return fetchImpl(`https://${host}/`, {
    method: 'POST',
    headers,
    body,
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

function countMeasurements(data: unknown): number {
  if (Array.isArray(data)) {
    return data.reduce((sum, item) => sum + countMeasurements(item), 0);
  }

  if (typeof data !== 'object' || data === null) {
    return 0;
  }

  const record = data as Record<string, unknown>;
  const ownMeasurements = Array.isArray(record.Measurements) ? record.Measurements.length : 0;

  return (
    ownMeasurements +
    Object.entries(record)
      .filter(([key]) => key !== 'Measurements')
      .reduce((sum, [, value]) => sum + countMeasurements(value), 0)
  );
}

function collectResolutions(data: unknown, resolutions = new Set<string>()): string[] {
  if (Array.isArray(data)) {
    for (const item of data) {
      collectResolutions(item, resolutions);
    }

    return [...resolutions].sort();
  }

  if (typeof data !== 'object' || data === null) {
    return [...resolutions].sort();
  }

  const record = data as Record<string, unknown>;
  const measurementResolutions = record.measurementResolutions;

  if (Array.isArray(measurementResolutions)) {
    for (const item of measurementResolutions) {
      if (typeof item === 'object' && item !== null) {
        const resolution = (item as Record<string, unknown>).resolution;

        if (typeof resolution === 'string' && resolution.trim()) {
          resolutions.add(resolution);
        }
      }
    }
  }

  for (const value of Object.values(record)) {
    collectResolutions(value, resolutions);
  }

  return [...resolutions].sort();
}

function hasQuarterHourResolution(resolutions: string[]): boolean {
  return resolutions.some((resolution) => {
    const normalized = resolution.toLowerCase();
    return normalized === 'pt15m' || normalized.includes('15min') || normalized.includes('kwartier');
  });
}

function assertUsageMonthInput(body: Record<string, unknown>) {
  const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
  const meteringPointId = typeof body.meteringPointId === 'string' ? body.meteringPointId.trim() : '';
  const year = Number(body.year);
  const month = Number(body.month);

  if (!/^\d{13,18}$/.test(connectionId)) {
    throw new Error('connectionId moet een numerieke EAN/connectie-id zijn.');
  }

  if (!/^[A-Za-z0-9_-]{1,40}$/.test(meteringPointId)) {
    throw new Error('meteringPointId heeft een ongeldig formaat.');
  }

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('year moet een geldig jaar zijn.');
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('month moet tussen 1 en 12 liggen.');
  }

  return { connectionId, meteringPointId, year, month };
}

function createUsageStore(fetchImpl: FetchLike): UsageStore | undefined {
  const tableName = process.env.KENTER_USAGE_TABLE;
  const rawBucket = process.env.KENTER_USAGE_RAW_BUCKET;
  const region = process.env.KENTER_USAGE_REGION || process.env.AWS_REGION || 'eu-central-1';

  if (!tableName || !rawBucket) {
    return undefined;
  }

  return {
    async putUsageMonth(entry) {
      const paddedMonth = String(entry.month).padStart(2, '0');
      const rawS3Key = [
        'kenter/usage/month',
        `connectionId=${entry.connectionId}`,
        `meteringPointId=${entry.meteringPointId}`,
        `year=${entry.year}`,
        `month=${paddedMonth}`,
        'response.json',
      ].join('/');
      const importedAt = new Date().toISOString();
      const rawResponse = await s3Request(
        fetchImpl,
        'PUT',
        rawBucket,
        region,
        rawS3Key,
        JSON.stringify(entry.rawResponse),
      );

      if (!rawResponse.ok) {
        throw new Error(`S3 usage write failed with status ${rawResponse.status}.`);
      }

      const item = {
        pk: { S: `EAN#${entry.connectionId}` },
        sk: { S: `MONTH#${entry.year}-${paddedMonth}#MP#${entry.meteringPointId}` },
        connectionId: { S: entry.connectionId },
        meteringPointId: { S: entry.meteringPointId },
        year: { N: String(entry.year) },
        month: { N: String(entry.month) },
        sourcePath: { S: entry.sourcePath },
        kenterStatus: { N: String(entry.kenterStatus) },
        hasQuarterHourData: { BOOL: entry.hasQuarterHourData },
        resolutions: { L: entry.resolutions.map((resolution) => ({ S: resolution })) },
        measurementCount: { N: String(countMeasurements(entry.rawResponse)) },
        channelCount: { N: String(Array.isArray(entry.rawResponse) ? entry.rawResponse.length : 0) },
        rawS3Bucket: { S: rawBucket },
        rawS3Key: { S: rawS3Key },
        importedAt: { S: importedAt },
      };
      const response = await dynamoRequest(
        fetchImpl,
        region,
        'DynamoDB_20120810.PutItem',
        JSON.stringify({ TableName: tableName, Item: item }),
      );

      if (!response.ok) {
        throw new Error(`DynamoDB usage write failed with status ${response.status}.`);
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

async function importUsageMonth(
  fetchImpl: FetchLike,
  store: UsageStore | undefined,
  body: Record<string, unknown>,
) {
  const input = assertUsageMonthInput(body);
  const paddedMonth = String(input.month).padStart(2, '0');
  const sourcePath =
    `/meetdata/v2/measurements/connections/${input.connectionId}` +
    `/metering-points/${input.meteringPointId}/months/${input.year}/${paddedMonth}`;
  const response = await fetchKenterPath(fetchImpl, sourcePath);
  const resolutions = collectResolutions(response.data);
  const hasQuarterHourData = hasQuarterHourResolution(resolutions);

  if (store && response.ok) {
    await store.putUsageMonth({
      ...input,
      sourcePath,
      kenterStatus: response.status,
      hasQuarterHourData,
      resolutions,
      rawResponse: response.data,
    });
  }

  return jsonResponse(response.status, {
    status: response.status,
    ok: response.ok,
    stored: Boolean(store && response.ok),
    hasQuarterHourData,
    resolutions,
    sourcePath,
    measurementCount: countMeasurements(response.data),
    data: response.data,
  });
}

export function createHandler(
  fetchImpl: FetchLike = fetch,
  meterStore = createS3MeterStore(fetchImpl),
  usageStore = createUsageStore(fetchImpl),
) {
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

      if (method === 'POST' && path === '/usage/month') {
        const body = parseJsonBody(event.body, event.isBase64Encoded);
        return importUsageMonth(fetchImpl, usageStore, body);
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
