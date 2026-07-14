# macOS Background Cold Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the current macOS application frontmost during a cold `--window background` Cloak launch while preserving headed persistent-browser behavior.

**Architecture:** Add one Darwin-only launcher that starts Cloak Chromium with `/usr/bin/open -g -n`, waits for Chromium's loopback CDP endpoint, and reconnects through Playwright. Route only cold macOS background launches through it. Explicit foreground selection reactivates an app that was launched in the background; Linux and Windows paths stay unchanged.

**Tech Stack:** TypeScript, Node.js standard library, CloakBrowser public launch helpers, Playwright CDP, Vitest.

## Global Constraints

- macOS-only behavior change; Linux and Windows remain unchanged.
- Background remains headed, persistent, fingerprinted, and humanized.
- No new dependency and no copied Playwright private argument tables.
- Never fall back to an activating launch for explicit background mode.
- Preserve Cloak's Playwright password-store flags so existing profile cookies remain readable.

---

### Task 1: Native macOS background launcher

**Files:**
- Create: `src/browser/runtime/local-cloak/darwin-background-launch.ts`
- Create: `src/browser/runtime/local-cloak/darwin-background-launch.test.ts`

**Interfaces:**
- Consumes: `LaunchPersistentContextOptions`, `buildLaunchOptions()`, and `humanizeBrowser()` from `cloakbrowser`; `chromium.connectOverCDP()` from `playwright-core`.
- Produces: `launchDarwinBackgroundPersistentContext(options): Promise<BrowserContext>` with the same return contract as CloakBrowser's persistent launcher.

- [ ] **Step 1: Write the failing launch test**

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext } from 'playwright-core';
import { launchDarwinBackgroundPersistentContext, waitForDevToolsPort } from './darwin-background-launch.js';

describe('launchDarwinBackgroundPersistentContext', () => {
  it('launches the Chromium app without activation and connects through loopback CDP', async () => {
    const context = { close: vi.fn() } as unknown as BrowserContext;
    const browser = {
      contexts: vi.fn(() => [context]),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
    const deps = {
      buildLaunchOptions: vi.fn().mockResolvedValue({
        executablePath: '/Applications/Cloak Chromium.app/Contents/MacOS/Chromium',
        args: ['--fingerprint=123'],
      }),
      humanizeBrowser: vi.fn().mockResolvedValue(undefined),
      openApplication: vi.fn().mockResolvedValue(undefined),
      readPort: vi.fn().mockResolvedValue(43123),
      connectOverCDP: vi.fn().mockResolvedValue(browser),
      terminateProfile: vi.fn().mockResolvedValue(undefined),
      removePortFile: vi.fn().mockResolvedValue(undefined),
    };

    const result = await launchDarwinBackgroundPersistentContext({
      userDataDir: '/tmp/cloak profile',
      headless: false,
      humanize: true,
    }, deps);

    expect(deps.openApplication).toHaveBeenCalledWith('/Applications/Cloak Chromium.app', [
      '--fingerprint=123',
      '--user-data-dir=/tmp/cloak profile',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      'about:blank',
    ]);
    expect(deps.removePortFile).toHaveBeenCalledWith('/tmp/cloak profile/DevToolsActivePort');
    expect(deps.connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:43123');
    expect(deps.humanizeBrowser).toHaveBeenCalledWith(browser, expect.objectContaining({ humanize: true }));
    expect(result).toBe(context);

    await result.close();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('fails immediately when the CDP port file misses its deadline', async () => {
    await expect(waitForDevToolsPort('/missing/DevToolsActivePort', 0)).rejects.toThrow(
      'Timed out waiting for background Chromium CDP endpoint',
    );
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/browser/runtime/local-cloak/darwin-background-launch.test.ts`

Expected: FAIL because `darwin-background-launch.js` does not exist.

- [ ] **Step 3: Implement the minimum launcher**

Create `darwin-background-launch.ts` with:

```ts
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { buildLaunchOptions, humanizeBrowser } from 'cloakbrowser';
import type { LaunchPersistentContextOptions } from 'cloakbrowser';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';

const execFileAsync = promisify(execFile);

type Dependencies = {
  buildLaunchOptions: typeof buildLaunchOptions;
  humanizeBrowser: typeof humanizeBrowser;
  openApplication: (appPath: string, args: string[]) => Promise<void>;
  readPort: (portFile: string) => Promise<number>;
  connectOverCDP: (endpoint: string) => Promise<Browser>;
  terminateProfile: (userDataDir: string) => Promise<void>;
  removePortFile: (portFile: string) => Promise<void>;
};

async function openApplication(appPath: string, args: string[]): Promise<void> {
  await execFileAsync('/usr/bin/open', ['-g', '-n', appPath, '--args', ...args]);
}

export async function waitForDevToolsPort(portFile: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const port = Number.parseInt((await readFile(portFile, 'utf8')).split('\n')[0], 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for background Chromium CDP endpoint');
}

async function terminateProfile(userDataDir: string): Promise<void> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command=']);
  const needle = `--user-data-dir=${userDataDir}`;
  for (const line of stdout.split('\n')) {
    if (!line.includes(needle)) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0], 10);
    if (Number.isInteger(pid) && pid !== process.pid) process.kill(pid, 'SIGTERM');
  }
}

const defaultDependencies: Dependencies = {
  buildLaunchOptions,
  humanizeBrowser,
  openApplication,
  readPort: waitForDevToolsPort,
  connectOverCDP: endpoint => chromium.connectOverCDP(endpoint),
  terminateProfile,
  removePortFile: portFile => rm(portFile, { force: true }),
};

function appPathFor(executablePath: string): string {
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const index = executablePath.lastIndexOf(marker);
  if (index < 0) throw new Error(`Cloak Chromium executable is not inside a macOS app bundle: ${executablePath}`);
  return executablePath.slice(0, index);
}

export async function launchDarwinBackgroundPersistentContext(
  options: LaunchPersistentContextOptions,
  deps: Dependencies = defaultDependencies,
): Promise<BrowserContext> {
  const portFile = path.join(options.userDataDir, 'DevToolsActivePort');
  await deps.removePortFile(portFile);
  const launchOptions = await deps.buildLaunchOptions(options);
  if (!launchOptions.executablePath) throw new Error('Cloak Chromium executable path is missing');

  let browser: Browser | undefined;
  let launched = false;
  try {
    await deps.openApplication(appPathFor(launchOptions.executablePath), [
      ...(launchOptions.args ?? []),
      `--user-data-dir=${options.userDataDir}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      'about:blank',
    ]);
    launched = true;
    const port = await deps.readPort(portFile);
    browser = await deps.connectOverCDP(`http://127.0.0.1:${port}`);
    await deps.humanizeBrowser(browser, options);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Background Chromium did not expose a persistent context');
    context.close = async () => browser!.close();
    return context;
  } catch (error) {
    await browser?.close().catch(() => {});
    if (launched) await deps.terminateProfile(options.userDataDir).catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 4: Add the failure-cleanup assertion**

Add a second launch test whose injected `connectOverCDP` rejects with `new Error('connect failed')`, then assert the exact failure and profile-scoped cleanup:

```ts
await expect(launchDarwinBackgroundPersistentContext(options, deps)).rejects.toThrow('connect failed');
expect(deps.terminateProfile).toHaveBeenCalledWith(options.userDataDir);
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run src/browser/runtime/local-cloak/darwin-background-launch.test.ts`

Expected: 3 tests pass.

- [ ] **Step 6: Commit the launcher**

```bash
git add src/browser/runtime/local-cloak/darwin-background-launch.ts src/browser/runtime/local-cloak/darwin-background-launch.test.ts
git commit -m "fix: launch background Cloak without macOS activation"
```

---

### Task 2: Route only cold macOS background runtimes

**Files:**
- Modify: `src/browser/runtime/local-cloak/session-manager.ts`
- Modify: `src/browser/runtime/local-cloak/session-manager.test.ts`

**Interfaces:**
- Consumes: `launchDarwinBackgroundPersistentContext(options): Promise<BrowserContext>` from Task 1.
- Produces: existing `CloakSessionManager.getPage()` behavior with Darwin/background-aware cold runtime creation.

- [ ] **Step 1: Write the failing routing test**

Add to `session-manager.test.ts`:

```ts
it.each([
  { platform: 'darwin', windowMode: 'background', backgroundCalls: 1, normalCalls: 0 },
  { platform: 'darwin', windowMode: 'foreground', backgroundCalls: 0, normalCalls: 1 },
  { platform: 'linux', windowMode: 'background', backgroundCalls: 0, normalCalls: 1 },
] as const)('routes a cold $platform $windowMode launch', async ({ platform, windowMode, backgroundCalls, normalCalls }) => {
  const launched = fakeContext();
  const launchPersistentContext = vi.fn().mockResolvedValue(launched.context);
  const launchBackgroundPersistentContext = vi.fn().mockResolvedValue(launched.context);
  const manager = new CloakSessionManager({
    baseDir: '/tmp/webcmd-test',
    platform,
    launchPersistentContext,
    launchBackgroundPersistentContext,
  });

  await manager.getPage({ profileId: 'default', session: 'work', surface: 'browser', windowMode });

  expect(launchBackgroundPersistentContext).toHaveBeenCalledTimes(backgroundCalls);
  expect(launchPersistentContext).toHaveBeenCalledTimes(normalCalls);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/browser/runtime/local-cloak/session-manager.test.ts`

Expected: FAIL because `platform` and `launchBackgroundPersistentContext` are not accepted and runtime creation ignores `windowMode`.

- [ ] **Step 3: Implement the routing**

In `session-manager.ts`:

```ts
import { launchDarwinBackgroundPersistentContext } from './darwin-background-launch.js';

export interface CloakSessionManagerOptions {
  baseDir?: string;
  launchPersistentContext?: LaunchPersistentContext;
  launchBackgroundPersistentContext?: LaunchPersistentContext;
  recoverLockedProfile?: RecoverLockedProfile;
  platform?: NodeJS.Platform;
}
```

Store the two new options in the constructor, pass `input.windowMode` into `getProfileRuntime()`, and select the launcher once inside `launchProfileRuntime()`:

```ts
const launchPersistentContext = this.platform === 'darwin' && windowMode === 'background'
  ? this.launchBackgroundPersistentContext
  : this.launchPersistentContext;
```

Use that local function for both the initial launch and the existing locked-profile retry. Do not change page reuse, selection, binding, or release logic.

- [ ] **Step 4: Run local Cloak tests and verify GREEN**

Run:

```bash
npx vitest run src/browser/runtime/local-cloak/session-manager.test.ts src/browser/runtime/local-cloak/provider.test.ts
```

Expected: both files pass, including the three routing cases.

- [ ] **Step 5: Commit routing**

```bash
git add src/browser/runtime/local-cloak/session-manager.ts src/browser/runtime/local-cloak/session-manager.test.ts
git commit -m "fix: route cold macOS background launches"
```

---

### Task 3: Repository and live verification

**Files:**
- Modify only if verification reveals a defect in Task 1 or Task 2 files.

**Interfaces:**
- Consumes: completed background launcher and runtime routing.
- Produces: verified cold/warm/foreground behavior and a clean branch.

- [ ] **Step 1: Run static and focused gates**

```bash
npm run typecheck
npm run build
npx vitest run src/browser/runtime/local-cloak/darwin-background-launch.test.ts src/browser/runtime/local-cloak/session-manager.test.ts src/browser/runtime/local-cloak/provider.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected baseline or better: 371 test files pass, 4,159 tests pass, 1 test is skipped.

- [ ] **Step 3: Verify cold and warm background focus**

Stop the source daemon, activate Safari, sample the frontmost app throughout each command, and run:

```bash
npm run dev -- daemon stop
npm run dev -- twitter whoami --window background -f json
npm run dev -- twitter whoami --window background -f json
```

Expected: both commands succeed and every focus sample is `Safari`.

- [ ] **Step 4: Verify foreground control**

Reactivate Safari and run:

```bash
npm run dev -- twitter whoami --window foreground -f json
```

Expected: the command succeeds and Chromium becomes frontmost, proving foreground behavior remains intact.

- [ ] **Step 5: Inspect the final branch**

```bash
git diff --check main...HEAD
git status --short --branch
git log --oneline --decorate main..HEAD
```

Expected: no whitespace errors, no uncommitted files, and only the design/plan plus focused fix commits.
