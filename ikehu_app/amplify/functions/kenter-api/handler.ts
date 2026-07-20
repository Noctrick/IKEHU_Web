type LambdaEvent = {
  rawPath?: string;
  path?: string;
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

let cachedToken: { accessToken: string; expiresAt: number } | undefined;

export function buildCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'content-type,authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: {
      ...buildCorsHeaders(),
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

async function fetchKenterPath(fetchImpl: FetchLike, path: string): Promise<LambdaResponse> {
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

  return jsonResponse(response.status, {
    status: response.status,
    ok: response.ok,
    data,
  });
}

export function createHandler(fetchImpl: FetchLike = fetch) {
  return async function route(event: LambdaEvent): Promise<LambdaResponse> {
    const method = event.requestContext?.http?.method ?? 'GET';
    const path = event.rawPath ?? event.path ?? '/';

    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: buildCorsHeaders(), body: '' };
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
        return fetchKenterPath(fetchImpl, '/meetdata/v2/meters?updates_days=0');
      }

      if (method === 'GET' && path === '/modified') {
        return fetchKenterPath(fetchImpl, '/meetdata/v2/measurements/modified');
      }

      if (method === 'POST' && path === '/fetch-url') {
        const body = parseJsonBody(event.body, event.isBase64Encoded);
        const targetUrl = typeof body.url === 'string' ? body.url : '';

        if (!isAllowedMeasurementPath(targetUrl)) {
          return jsonResponse(400, {
            error: 'Only relative measurement URLs under /meetdata/v2/measurements/ are allowed.',
          });
        }

        return fetchKenterPath(fetchImpl, targetUrl);
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

