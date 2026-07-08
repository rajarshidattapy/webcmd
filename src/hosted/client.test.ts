import { describe, expect, it } from 'vitest';
import { HostedClient, HostedClientError } from './client.js';

describe('HostedClient', () => {
  it('sends bearer auth and parses hosted manifest', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = new HostedClient({
      apiBaseUrl: 'https://api.example.com/',
      apiKey: 'wcmd_live_test',
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify({
          ok: true,
          manifest: { userId: 'user_demo', generatedAt: 'now', commands: [] },
        }), { status: 200 });
      },
    });

    await expect(client.getManifest()).resolves.toEqual({
      userId: 'user_demo',
      generatedAt: 'now',
      commands: [],
    });
    expect(requests).toEqual([{ url: 'https://api.example.com/v1/manifest', authorization: 'Bearer wcmd_live_test' }]);
  });

  it('maps hosted error envelopes to CliError-compatible errors', async () => {
    const client = new HostedClient({
      apiBaseUrl: 'https://api.example.com',
      apiKey: 'bad',
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid key',
          help: 'Run setup',
          exitCode: 77,
        },
      }), { status: 401 }),
    });

    await expect(client.getManifest()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid key',
      hint: 'Run setup',
      exitCode: 77,
    } satisfies Partial<HostedClientError>);
  });
});
