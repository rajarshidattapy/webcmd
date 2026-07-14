# macOS Background Cold Launch Design

## Problem

`--window background` skips Webcmd's explicit `bringToFront()` calls, but the first browser-backed command after a daemon stop still makes Cloak Chromium the frontmost macOS application. Warm commands reuse the existing persistent page and preserve focus correctly.

The remaining activation happens when Playwright launches the headed Chromium application. Chromium's `--start-minimized` flag still activates the app on macOS, and `--no-startup-window` prevents Playwright's persistent-context handshake from completing.

## Goals

- Keep the currently active macOS application frontmost during a cold `--window background` command.
- Preserve headed Chromium, the persistent Cloak profile, cookies, fingerprint arguments, and humanized interaction.
- Leave explicit/default foreground behavior unchanged.
- Leave Linux and Windows behavior unchanged.
- Add no dependency.

## Non-goals

- Background mode does not become headless mode.
- Warm tab selection and binding are not redesigned; PR #65 already handles them.
- Webcmd will not restore focus after stealing it. The launch itself must be non-activating.
- Webcmd will not copy Playwright's private Chromium argument tables.

## Chosen Approach

Add one macOS-only background launcher beside the local Cloak runtime. It will use the native `open -g -n` command to launch Cloak's Chromium application without activation, then connect Playwright to that process through a loopback CDP endpoint.

The launcher will reuse CloakBrowser's public `buildLaunchOptions()` output for the binary path and fingerprint arguments, and `humanizeBrowser()` for interaction patching. It will add only the persistent-profile and CDP arguments Webcmd owns:

- `--user-data-dir=<profile>`
- `--password-store=basic`
- `--use-mock-keychain`
- `--remote-debugging-address=127.0.0.1`
- `--remote-debugging-port=0`
- the initial `about:blank` target

The password-store flags match CloakBrowser's normal Playwright launch behavior so existing profile cookies remain readable. Chromium writes the selected port to `<profile>/DevToolsActivePort`. Webcmd will wait for that file, connect with `chromium.connectOverCDP()`, use the default persistent context, and make context shutdown close the connected browser process.

A live prototype of this flow launched and navigated Chromium while Safari remained frontmost for all 15 samples.

## Runtime Routing

`CloakSessionManager.getPage()` already receives `windowMode`. Runtime creation will receive that value as well.

- macOS + cold runtime + `background`: use the native background launcher.
- macOS + foreground/default: keep `cloakbrowser.launchPersistentContext()` unchanged.
- Linux/Windows: keep `cloakbrowser.launchPersistentContext()` unchanged.
- Warm runtime: reuse the existing runtime exactly as today.

Because Playwright cannot make an application launched with `open -g` become the active macOS application, an explicit foreground tab selection will activate the existing app bundle after `bringToFront()`. Background selections never call that activator.

The existing per-profile launch promise remains the concurrency boundary, so only one cold launch can own a profile at a time.

## Failure Handling

- Remove a stale `DevToolsActivePort` before launching so Webcmd cannot connect to an old endpoint.
- Bind CDP to loopback and let Chromium select a random port.
- Fail with a clear timeout if the port file or CDP connection does not become ready.
- Terminate only the Chromium process whose command line contains the exact profile directory if launch or connection fails.
- Never fall back to the activating Playwright launch for an explicit background request.
- Preserve the existing locked-profile recovery attempt.

## Files

- Add `src/browser/runtime/local-cloak/darwin-background-launch.ts` for native launch, CDP connection, and cleanup.
- Modify `src/browser/runtime/local-cloak/session-manager.ts` only to route cold macOS background launches.
- Add focused unit coverage beside the local Cloak runtime tests.

## Verification

1. Test-first unit coverage must prove the cold macOS background request selects the native launcher while foreground and non-macOS requests retain the existing launcher.
2. Helper tests must cover native arguments, stale port-file removal, CDP connection, explicit activation, shutdown, timeout, and scoped cleanup.
3. Run the focused local-Cloak tests, typecheck, build, and the full test suite.
4. Stop the daemon, put Safari in front, and run `npm run dev -- twitter whoami --window background -f json` while sampling the frontmost application.
5. Repeat the command against the warm session.
6. Confirm Safari remains frontmost throughout both runs, then confirm an explicit foreground run still activates Chromium.
