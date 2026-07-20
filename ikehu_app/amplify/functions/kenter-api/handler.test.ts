import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  clearTokenCacheForTests,
  createHandler,
  isAllowedMeasurementPath,
  parseJsonBody,
} from './handler';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  clearTokenCacheForTests();
});

test('isAllowedMeasurementPath accepts only relative Kenter measurement paths', () => {
  assert.equal(
    isAllowedMeasurementPath(
      '/meetdata/v2/measurements/connections/123/metering-points/456/days/2026/7/19',
    ),
    true,
  );
  assert.equal(isAllowedMeasurementPath('/meetdata/v2/meters'), false);
  assert.equal(isAllowedMeasurementPath('https://example.com/meetdata/v2/measurements/x'), false);
  assert.equal(isAllowedMeasurementPath('//example.com/meetdata/v2/measurements/x'), false);
  assert.equal(isAllowedMeasurementPath('/other/v2/measurements/x'), false);
});

test('parseJsonBody returns an empty object for missing body', () => {
  assert.deepEqual(parseJsonBody(undefined), {});
});

test('parseJsonBody decodes base64 encoded request bodies', () => {
  const encoded = Buffer.from(JSON.stringify({ url: '/meetdata/v2/measurements/test' })).toString(
    'base64',
  );
  assert.deepEqual(parseJsonBody(encoded, true), { url: '/meetdata/v2/measurements/test' });
});

test('health reports missing Kenter credentials without calling Kenter', async () => {
  delete process.env.KENTER_CLIENT_ID;
  delete process.env.KENTER_CLIENT_SECRET;

  const handler = createHandler(async () => {
    throw new Error('fetch should not be called');
  });

  const response = await handler({ rawPath: '/health', requestContext: { http: { method: 'GET' } } });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, { 'Content-Type': 'application/json' });
  assert.equal(body.ok, true);
  assert.equal(body.configured, false);
});

test('fetch-url rejects unsafe target paths before token retrieval', async () => {
  process.env.KENTER_CLIENT_ID = 'client';
  process.env.KENTER_CLIENT_SECRET = 'secret';

  const handler = createHandler(async () => {
    throw new Error('fetch should not be called');
  });

  const response = await handler({
    rawPath: '/fetch-url',
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify({ url: 'https://example.com/meetdata/v2/measurements/test' }),
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 400);
  assert.match(body.error, /Only relative measurement URLs/);
});

test('meters route obtains a token and forwards the Kenter response', async () => {
  process.env.KENTER_CLIENT_ID = 'client';
  process.env.KENTER_CLIENT_SECRET = 'secret';

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const handler = createHandler(async (url, init) => {
    calls.push({ url: String(url), init });

    if (String(url).includes('/connect/token')) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify([{ connectionId: '123' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const response = await handler({ rawPath: '/meters', requestContext: { http: { method: 'GET' } } });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.data, [{ connectionId: '123' }]);
  assert.equal(calls[1].url, 'https://api.kenter.nu/meetdata/v2/meters?updates_days=0');
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, 'Bearer token');
});

test('meters route returns fresh cached data without calling Kenter', async () => {
  const handler = createHandler(
    async () => {
      throw new Error('fetch should not be called');
    },
    {
      async get() {
        return {
          fetchedAt: new Date().toISOString(),
          response: {
            status: 200,
            ok: true,
            data: [{ connectionId: 'cached' }],
          },
        };
      },
      async put() {
        throw new Error('put should not be called');
      },
    },
  );

  const response = await handler({ rawPath: '/meters', requestContext: { http: { method: 'GET' } } });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.data, [{ connectionId: 'cached' }]);
  assert.equal(body.cache.hit, true);
});

test('meters refresh fetches Kenter and stores the result', async () => {
  process.env.KENTER_CLIENT_ID = 'client';
  process.env.KENTER_CLIENT_SECRET = 'secret';

  let storedData: unknown;
  const calls: Array<string> = [];
  const handler = createHandler(
    async (url) => {
      calls.push(String(url));

      if (String(url).includes('/connect/token')) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify([{ connectionId: 'fresh' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    {
      async get() {
        return {
          fetchedAt: new Date().toISOString(),
          response: {
            status: 200,
            ok: true,
            data: [{ connectionId: 'cached' }],
          },
        };
      },
      async put(entry) {
        storedData = entry.response.data;
      },
    },
  );

  const response = await handler({
    rawPath: '/meters/refresh',
    requestContext: { http: { method: 'GET' } },
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(body.data, [{ connectionId: 'fresh' }]);
  assert.deepEqual(storedData, [{ connectionId: 'fresh' }]);
  assert.equal(body.cache.hit, false);
  assert.equal(body.cache.stored, true);
});
