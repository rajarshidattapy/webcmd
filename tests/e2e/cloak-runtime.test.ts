import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './helpers.js';

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/cookie') {
      res.setHeader('Set-Cookie', 'webcmd_smoke=ok; Path=/');
      res.end('<html><title>Cookie</title><body>cookie</body></html>');
      return;
    }

    if (req.url === '/api') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/counter') {
      const index = requestUrl.searchParams.get('index');
      if (!index || !/^\d+$/.test(index)) {
        res.statusCode = 400;
        res.end('invalid counter index');
        return;
      }
      res.end(`<html><title>Counter ${index}</title><body data-index="${index}">counter</body></html>`);
      return;
    }

    res.end('<html><title>Cloak Smoke</title><body><button id="b">Go</button><script>window.answer = 42</script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Cloak runtime e2e', () => {
  it('opens a page and evaluates JavaScript through webcmd browser', async () => {
    const session = `cloak-smoke-${Date.now()}`;
    const open = await runCli(['browser', session, 'open', baseUrl], { timeout: 120_000 });
    expect(open.code).toBe(0);

    const evalResult = await runCli(['browser', session, 'eval', 'document.title + ":" + window.answer'], { timeout: 120_000 });
    expect(evalResult.code).toBe(0);
    expect(evalResult.stdout).toContain('Cloak Smoke:42');
  }, 180_000);

  it('persists cookies inside the Cloak profile', async () => {
    const session = `cloak-cookie-${Date.now()}`;
    expect((await runCli(['browser', session, 'open', `${baseUrl}/cookie`], { timeout: 120_000 })).code).toBe(0);
    const cookies = await runCli(['browser', session, 'eval', 'document.cookie'], { timeout: 120_000 });
    expect(cookies.code).toBe(0);
    expect(cookies.stdout).toContain('webcmd_smoke=ok');
  }, 180_000);

  it('survives sequential open and evaluate cycles in one persistent profile', async () => {
    const session = `cloak-sequential-${Date.now()}`;
    const profile = `task5-${Date.now()}`;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcmd-cloak-sequential-'));
    const run = (args: string[]) => runCli(args, {
      timeout: 120_000,
      env: {
        WEBCMD_CONFIG_DIR: configDir,
        WEBCMD_PROFILE: profile,
      },
    });
    const waitForStoppedDaemon = async () => {
      let status = await run(['daemon', 'status']);
      for (let attempt = 0; attempt < 20 && !status.stdout.includes('Daemon: not running'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 250));
        status = await run(['daemon', 'status']);
      }
      return status;
    };
    let stopCode: number | undefined;
    let stoppedStatus = { stdout: '', stderr: '', code: 1 };

    try {
      expect((await run(['daemon', 'stop'])).code).toBe(0);
      expect((await waitForStoppedDaemon()).stdout).toContain('Daemon: not running');

      try {
        expect((await run(['browser', session, 'open', `${baseUrl}/cookie`])).code).toBe(0);

        for (let index = 0; index < 3; index += 1) {
          const open = await run(['browser', session, 'open', `${baseUrl}/counter?index=${index}`]);
          expect(open.code).toBe(0);

          const evaluated = await run(['browser', session, 'eval', 'document.body.dataset.index']);
          expect(evaluated.code).toBe(0);
          expect(evaluated.stdout.trim()).toBe(String(index));
        }

        const cookies = await run(['browser', session, 'eval', 'document.cookie']);
        expect(cookies.code).toBe(0);
        expect(cookies.stdout).toContain('webcmd_smoke=ok');

        const status = await run(['daemon', 'status']);
        expect(status.code).toBe(0);
        expect(status.stdout).toContain('Daemon: running');
        expect(status.stdout).toContain('Runtime: cloak connected');
        expect(status.stdout).toContain(`Profiles: ${profile}`);
      } finally {
        const stopped = await run(['daemon', 'stop']);
        stopCode = stopped.code;
      }

    } finally {
      if (stopCode !== undefined) {
        stoppedStatus = await waitForStoppedDaemon();
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }

    expect(stopCode).toBe(0);
    expect(stoppedStatus.code).toBe(0);
    expect(stoppedStatus.stdout).toContain('Daemon: not running');
  }, 480_000);
});
