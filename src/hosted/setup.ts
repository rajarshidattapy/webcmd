import { createInterface } from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { writeToStream } from '../stream-write.js';
import { HostedClient } from './client.js';
import {
  defaultHostedApiBaseUrl,
  makeLocalConfig,
  saveWebcmdConfig,
  type ConfigIo,
} from './config.js';
import {
  makeStoredHostedConfig,
  storeHostedApiKey,
  type HostedCredentialBackend,
  type HostedCredentialIo,
} from './credentials.js';

export interface SetupIo extends ConfigIo, HostedCredentialIo {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  fetchImpl?: typeof fetch;
  question?: (prompt: string) => Promise<string>;
  write?: (message: string) => void | Promise<void>;
}

export async function runHostedSetup(io: SetupIo = {}): Promise<number> {
  const write = io.write
    ? async (message: string) => { await io.write!(message); }
    : async (message: string) => writeToStream(io.output ?? defaultOutput, message);
  const ownedReadline = io.question ? undefined : createInterface({
    input: io.input ?? defaultInput,
    output: io.output ?? defaultOutput,
  });
  const ask = io.question ?? ((prompt: string) => ownedReadline!.question(prompt));

  try {
    await write('Webcmd setup\n');
    const mode = await ask('Use hosted Webcmd Cloud or local Webcmd? [hosted/local] ');
    if (mode.trim().toLowerCase().startsWith('l')) {
      saveWebcmdConfig(makeLocalConfig(io.now?.() ?? new Date()), io);
      await write('Webcmd is now configured for local mode.\n');
      return 0;
    }

    const apiBaseUrl = defaultHostedApiBaseUrl(io.env ?? process.env);
    const apiKey = (await ask('Webcmd API key: ')).trim();
    if (!apiKey) {
      await write('A Webcmd API key is required for hosted mode.\n');
      return 2;
    }

    let accountLabel: string | undefined;
    try {
      const me = await new HostedClient({
        apiBaseUrl,
        apiKey,
        fetchImpl: io.fetchImpl,
      }).getMe();
      accountLabel = hostedAccountLabel(me);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await write(`Warning: could not verify API key yet: ${message}\n`);
    }
    const credential = await storeHostedApiKey(apiKey, io);
    const config = makeStoredHostedConfig({
      apiBaseUrl,
      apiKeyRef: credential.apiKeyRef,
      credentialBackend: credential.credentialBackend,
      now: io.now?.() ?? new Date(),
    });
    saveWebcmdConfig(config, io);
    if (accountLabel) await write(`Verified Webcmd Cloud account: ${accountLabel}\n`);
    if (credential.credentialBackend === 'file-fallback') {
      await write('Warning: OS credential storage was unavailable; API key stored in a protected Webcmd credentials file.\n');
    }
    await write(`Credential backend: ${credentialBackendLabel(credential.credentialBackend)}.\n`);
    await write('Webcmd is now configured for hosted mode.\n');
    return 0;
  } finally {
    ownedReadline?.close();
  }
}

function hostedAccountLabel(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const user = (body as { user?: unknown }).user;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return undefined;
  const record = user as { email?: unknown; id?: unknown };
  if (typeof record.email === 'string' && record.email.trim()) return record.email.trim();
  if (typeof record.id === 'string' && record.id.trim()) return record.id.trim();
  return undefined;
}

function credentialBackendLabel(backend: HostedCredentialBackend): string {
  return backend === 'os' ? 'OS credential store' : 'protected file fallback';
}
