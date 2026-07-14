import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { makeHostedConfig } from './config.js';
import { runHostedCli } from './runner.js';

const manifest = {
  userId: 'user_demo',
  metadata: {
    contractSchemaVersion: 1,
    webcmdPackageVersion: '0.3.0',
    generatedAt: '2026-07-08T00:00:00.000Z',
  },
  commands: [
    {
      site: 'github',
      name: 'whoami',
      command: 'github/whoami',
      description: 'Show GitHub identity',
      access: 'read',
      strategy: 'COOKIE',
      browser: true,
      args: [],
      columns: ['username'],
      domain: 'github.com',
    },
    {
      site: 'docker',
      name: 'ps',
      command: 'docker/ps',
      description: 'Local Docker containers',
      access: 'read',
      strategy: 'LOCAL',
      browser: false,
      args: [],
      columns: ['id'],
    },
  ],
};

function sink(isTTY = false): { stream: Writable; text: () => string } {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });
  Object.defineProperty(stream, 'isTTY', { value: isTTY });
  return { stream, text: () => data };
}

function manifestResponse(): Response {
  return new Response(JSON.stringify({ ok: true, manifest }), { status: 200 });
}

function executionResponse(input: {
  result: unknown;
  columns?: string[];
  trace?: Record<string, unknown>;
  command?: string;
}): Response {
  return new Response(JSON.stringify({
    ok: true,
    result: input.result,
    ...(input.columns ? { columns: input.columns } : {}),
    execution: { id: 'exec_success', command: input.command ?? 'github/whoami', status: 'succeeded' },
    ...(input.trace ? { trace: input.trace } : {}),
  }), { status: 200 });
}

describe('runHostedCli', () => {
  it('renders hosted list without LOCAL commands', async () => {
    const stdout = sink();

    const result = await runHostedCli(['list', '-f', 'json'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      fetchImpl: async () => manifestResponse(),
    });

    expect(result).toEqual({ handled: true, exitCode: 0 });
    expect(stdout.text()).toContain('github/whoami');
    expect(stdout.text()).not.toContain('docker/ps');
  });

  it('dispatches hosted commands to /v1/execute', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const stdout = sink();

    const result = await runHostedCli(['github', 'whoami', '-f', 'json'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
        });
        if (String(url).endsWith('/v1/manifest')) {
          return manifestResponse();
        }
        return executionResponse({ result: [{ username: 'octocat' }], columns: ['username'] });
      },
    });

    expect(result).toEqual({ handled: true, exitCode: 0 });
    expect(requests.at(-1)).toEqual({
      url: 'https://api.example.com/v1/execute',
      body: {
        command: 'github/whoami',
        args: {},
        format: 'json',
        trace: 'off',
      },
    });
    expect(stdout.text()).toBe('[\n  {\n    "username": "octocat"\n  }\n]\n');
  });

  it.each([
    { name: 'scalar field', result: { value: 'hello' }, argv: ['-f', 'plain'], expected: 'hello\n' },
    {
      name: 'multiple rows',
      result: [{ username: 'alice' }, { username: 'bob' }],
      argv: ['-f', 'csv'],
      expected: 'username\nalice\nbob\n',
    },
    {
      name: 'CSV escaping',
      result: [{ username: 'a,"b\nline 2' }],
      argv: ['-f', 'csv'],
      expected: 'username\n"a,""b\nline 2"\n',
    },
    {
      name: 'Markdown escaping',
      result: [{ username: 'a|b\nline 2' }],
      argv: ['-f', 'md'],
      expected: '| username |\n| --- |\n| a\\|b<br>line 2 |\n',
    },
  ])('renders hosted $name with canonical literal bytes', async ({ result, argv, expected }) => {
    const stdout = sink(true);
    await runHostedCli(['github', 'whoami', ...argv], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      fetchImpl: async (url) => String(url).endsWith('/v1/manifest')
        ? manifestResponse()
        : executionResponse({ result }),
    });

    expect(stdout.text()).toBe(expected);
  });

  it('uses the response columns and falls back to command columns', async () => {
    const withResponseColumns = sink();
    const withoutResponseColumns = sink();
    const result = [{ username: 'octocat', secret: 'hidden' }];
    const run = async (stdout: ReturnType<typeof sink>, columns?: string[]) => runHostedCli([
      'github', 'whoami', '-f', 'csv',
    ], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      fetchImpl: async (url) => String(url).endsWith('/v1/manifest')
        ? manifestResponse()
        : executionResponse({ result, ...(columns ? { columns } : {}) }),
    });

    await run(withResponseColumns, ['secret']);
    await run(withoutResponseColumns);

    expect(withResponseColumns.text()).toBe('secret\nhidden\n');
    expect(withoutResponseColumns.text()).toBe('username\noctocat\n');
  });

  it('propagates implicit versus explicit table format to non-TTY rendering', async () => {
    const implicit = sink(false);
    const explicit = sink(false);
    const run = async (stdout: ReturnType<typeof sink>, argv: string[]) => runHostedCli(argv, {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      fetchImpl: async (url) => String(url).endsWith('/v1/manifest')
        ? manifestResponse()
        : executionResponse({ result: [{ username: 'octocat' }] }),
    });

    await run(implicit, ['github', 'whoami']);
    await run(explicit, ['github', 'whoami', '-f', 'table']);

    expect(implicit.text()).toBe('- username: octocat\n\n');
    expect(explicit.text()).toContain('octocat');
    expect(explicit.text()).not.toContain('username: octocat');
  });

  it('uses the command default format only when format was not explicit', async () => {
    const implicit = sink(false);
    const explicit = sink(false);
    const manifestWithDefault = {
      ...manifest,
      commands: manifest.commands.map(command => command.command === 'github/whoami'
        ? { ...command, defaultFormat: 'plain' }
        : command),
    };
    const run = async (stdout: ReturnType<typeof sink>, argv: string[]) => runHostedCli(argv, {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      fetchImpl: async (url) => String(url).endsWith('/v1/manifest')
        ? new Response(JSON.stringify({ ok: true, manifest: manifestWithDefault }), { status: 200 })
        : executionResponse({ result: { response: 'hello' } }),
    });

    await run(implicit, ['github', 'whoami']);
    await run(explicit, ['github', 'whoami', '-f', 'json']);

    expect(implicit.text()).toBe('hello\n');
    expect(explicit.text()).toBe('{\n  "response": "hello"\n}\n');
  });

  it('renders only response.result with canonical local table labels and elapsed semantics', async () => {
    const stdout = sink(true);
    const times = [1_000, 1_250];
    await runHostedCli(['github', 'whoami', '-f', 'table'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      now: () => times.shift() ?? 1_250,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/v1/manifest')) return manifestResponse();
        return new Response(JSON.stringify({
          ok: true,
          result: [{ username: 'octocat' }],
          execution: { id: 'exec_success', command: 'github/whoami', status: 'succeeded' },
        }), { status: 200 });
      },
    });

    expect(stdout.text()).toContain('octocat');
    expect(stdout.text()).toContain('  github/whoami');
    expect(stdout.text()).toContain('1 items | 0.3s | github/whoami');
    expect(stdout.text()).not.toContain('webcmd cloud');
  });

  it('writes a successful trace=on receipt to injected stderr exactly once', async () => {
    const stdout = sink();
    const stderr = sink();
    await runHostedCli(['github', 'whoami', '--trace', 'on', '-f', 'json'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchImpl: async (url) => String(url).endsWith('/v1/manifest')
        ? manifestResponse()
        : executionResponse({
            result: [{ username: 'octocat' }],
            trace: {
              receipt: 'trace_receipt',
              executionId: 'exec_success',
              artifactsUrl: '/v1/executions/exec_success/artifacts',
            },
          }),
    });

    expect(stderr.text()).toBe('Webcmd trace artifact: trace_receipt\n');
    expect(stdout.text()).not.toContain('trace_receipt');
  });

  it.each(['off', 'retain-on-failure'])('does not write a success trace notice for trace=%s', async (trace) => {
    const stderr = sink();
    await runHostedCli(['github', 'whoami', '--trace', trace, '-f', 'json'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: sink().stream,
      stderr: stderr.stream,
      fetchImpl: async (url) => String(url).endsWith('/v1/manifest')
        ? manifestResponse()
        : executionResponse({ result: [] }),
    });

    expect(stderr.text()).toBe('');
  });

  it('attaches hosted failure trace metadata to the local error envelope', async () => {
    const stderr = sink();
    const result = await runHostedCli(['github', 'whoami', '--trace', 'retain-on-failure'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: sink().stream,
      stderr: stderr.stream,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/v1/manifest')) return manifestResponse();
        return new Response(JSON.stringify({
          ok: false,
          error: { code: 'AUTH_REQUIRED', message: 'Sign in first', exitCode: 77 },
          execution: { id: 'exec_failure', command: 'github/whoami', status: 'failed' },
          trace: {
            receipt: 'trace_failure',
            executionId: 'exec_failure',
            artifactsUrl: '/v1/executions/exec_failure/artifacts',
          },
        }), { status: 401 });
      },
    });

    expect(result).toEqual({ handled: true, exitCode: 77 });
    expect(stderr.text()).toContain('receipt: trace_failure');
    expect(stderr.text()).toContain('executionId: exec_failure');
    expect(stderr.text()).not.toContain('Webcmd trace artifact:');
  });

  it.each(['success', 'failure'])('rejects a raw provider trace URL before $phase output or attachment', async (phase) => {
    const rawUrl = 'https://kernel.example/session/private?token=kernel-secret-token';
    const stdout = sink();
    const stderr = sink();
    const success = phase === 'success';
    const result = await runHostedCli([
      'github',
      'whoami',
      '--trace',
      success ? 'on' : 'retain-on-failure',
      '-f',
      'json',
    ], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/v1/manifest')) return manifestResponse();
        return new Response(JSON.stringify(success ? {
          ok: true,
          result: [{ username: 'octocat' }],
          execution: { id: 'exec_trace', command: 'github/whoami', status: 'succeeded' },
          trace: { receipt: 'trace_receipt', executionId: 'exec_trace', liveViewUrl: rawUrl },
        } : {
          ok: false,
          error: { code: 'AUTH_REQUIRED', message: 'Sign in first', exitCode: 77 },
          execution: { id: 'exec_trace', command: 'github/whoami', status: 'failed' },
          trace: { receipt: 'trace_receipt', executionId: 'exec_trace', liveViewUrl: rawUrl },
        }), { status: success ? 200 : 401 });
      },
    });

    expect(result).toEqual({ handled: true, exitCode: 1 });
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toContain('HOSTED_PROTOCOL');
    expect(`${stdout.text()}\n${stderr.text()}`).not.toContain(rawUrl);
    expect(`${stdout.text()}\n${stderr.text()}`).not.toContain('kernel-secret-token');
  });

  it('rejects a manifest whose identity differs from installed hosted-contract.json before execution', async () => {
    const requests: string[] = [];
    const stderr = sink();
    const mismatched = {
      ...manifest,
      metadata: { ...manifest.metadata, webcmdPackageVersion: '999.0.0' },
    };
    const result = await runHostedCli(['github', 'whoami'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stderr: stderr.stream,
      fetchImpl: async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ ok: true, manifest: mismatched }), { status: 200 });
      },
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text()).toMatch(/HOSTED_PROTOCOL|hosted contract/i);
    expect(requests).toEqual(['https://api.example.com/v1/manifest']);
  });

  it('writes a result larger than 1 MiB completely through injected stdout', async () => {
    const value = 'x'.repeat((1024 * 1024) + 31);
    const stdout = sink();
    await runHostedCli(['github', 'whoami', '-f', 'plain'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      fetchImpl: async (url) => String(url).endsWith('/v1/manifest')
        ? manifestResponse()
        : executionResponse({ result: { value } }),
    });

    const expected = `${value}\n`;
    expect(stdout.text().length).toBe(expected.length);
    expect(createHash('sha256').update(stdout.text()).digest('hex'))
      .toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('rejects daemon commands in hosted mode', async () => {
    const stderr = sink();
    const result = await runHostedCli(['daemon', 'status'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stderr: stderr.stream,
    });

    expect(result.exitCode).toBe(78);
    expect(stderr.text()).toMatch(/hosted mode has no local daemon/i);
  });

  it('routes hosted browser positional commands through the cloud lifecycle', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const stdout = sink();
    const result = await runHostedCli(['--profile', 'default', 'browser', 'work', 'open', 'https://example.com', '--window', 'background'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
        });
        if (String(url).endsWith('/v1/manifest')) return manifestResponse();
        if (String(url).endsWith('/runs')) {
          return new Response(JSON.stringify({
            ok: true,
            run: {
              executionId: 'exec_browser',
              session: 'work',
              profile: { id: 'profile_default', displayName: 'default' },
            },
          }), { status: 201 });
        }
        if (String(url).endsWith('/actions')) {
          return new Response(JSON.stringify({
            ok: true,
            result: { url: 'https://example.com' },
            columns: ['url'],
            trace: null,
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          ok: true,
          execution: { id: 'exec_browser', status: 'succeeded' },
        }), { status: 200 });
      },
    });

    expect(result).toEqual({ handled: true, exitCode: 0 });
    expect(stdout.text()).toContain('https://example.com');
    expect(requests).toEqual([
      {
        url: 'https://api.example.com/v1/manifest',
        body: undefined,
      },
      {
        url: 'https://api.example.com/v1/browser/work/runs',
        body: {
          command: 'browser/open',
          args: { url: 'https://example.com' },
          profile: 'default',
          windowMode: 'background',
          trace: 'off',
        },
      },
      {
        url: 'https://api.example.com/v1/browser/work/runs/exec_browser/actions',
        body: {
          action: 'navigate',
          args: { url: 'https://example.com' },
          profile: 'default',
        },
      },
      {
        url: 'https://api.example.com/v1/browser/work/runs/exec_browser/finish',
        body: {
          status: 'succeeded',
          profile: 'default',
        },
      },
    ]);
  });

  it('rejects a browser manifest mismatch before starting a provider run', async () => {
    const requests: string[] = [];
    const stdout = sink();
    const stderr = sink();
    const mismatched = {
      ...manifest,
      metadata: { ...manifest.metadata, webcmdPackageVersion: '999.0.0' },
    };
    const result = await runHostedCli(['browser', 'work', 'state'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchImpl: async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ ok: true, manifest: mismatched }), { status: 200 });
      },
    });

    expect(result.exitCode).toBe(1);
    expect(requests).toEqual(['https://api.example.com/v1/manifest']);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toMatch(/HOSTED_PROTOCOL|hosted contract/i);
  });

  it('does not render private fields from a malformed browser action success', async () => {
    const requests: string[] = [];
    const stdout = sink();
    const stderr = sink();
    const privatePath = '/srv/private/token.json';
    const result = await runHostedCli(['browser', 'work', 'state'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetchImpl: async (url) => {
        requests.push(String(url));
        if (String(url).endsWith('/v1/manifest')) return manifestResponse();
        if (String(url).endsWith('/runs')) {
          return new Response(JSON.stringify({
            ok: true,
            run: {
              executionId: 'exec_browser',
              session: 'work',
              profile: { id: 'profile_default', displayName: 'default' },
            },
          }), { status: 201 });
        }
        if (String(url).endsWith('/actions')) {
          return new Response(JSON.stringify({ ok: true, internalPath: privatePath }), { status: 200 });
        }
        return new Response(JSON.stringify({
          ok: true,
          execution: { id: 'exec_browser', status: 'failed' },
        }), { status: 200 });
      },
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text()).toBe('');
    expect(stdout.text()).not.toContain(privatePath);
    expect(stderr.text()).toContain('HOSTED_PROTOCOL');
    expect(stderr.text()).not.toContain(privatePath);
    expect(requests).toEqual([
      'https://api.example.com/v1/manifest',
      'https://api.example.com/v1/browser/work/runs',
      'https://api.example.com/v1/browser/work/runs/exec_browser/actions',
      'https://api.example.com/v1/browser/work/runs/exec_browser/finish',
    ]);
  });

  it('reconstructs AutoFix commands without treating global option values as command words', async () => {
    const stderr = sink();
    const result = await runHostedCli(['--profile', 'default', 'github', 'whoami'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stderr: stderr.stream,
      fetchImpl: async () => { throw new Error('network failed'); },
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text()).toContain('# webcmd github whoami --trace retain-on-failure');
    expect(stderr.text()).not.toContain('# webcmd default github');
  });

  it('rejects the retired hosted browser --session flag', async () => {
    const stderr = sink();
    const result = await runHostedCli(['browser', '--session', 'work', 'state'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stderr: stderr.stream,
    });

    expect(result.exitCode).toBe(78);
    expect(stderr.text()).toMatch(/session.*no longer a public option/i);
  });

  it('rejects browser bind before making a hosted request', async () => {
    const stderr = sink();
    const fetchImpl = vi.fn<typeof fetch>();

    const result = await runHostedCli(['browser', 'work', 'bind'], {
      config: makeHostedConfig({ apiBaseUrl: 'https://api.example.com', apiKey: 'key' }),
      stderr: stderr.stream,
      fetchImpl,
    });

    expect(result).toEqual({ handled: true, exitCode: 78 });
    expect(stderr.text()).toMatch(/browser bind is not supported in hosted mode/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
