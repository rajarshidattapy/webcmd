import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_DIR_NAME, ENV_PREFIX } from '../brand.js';
import type { HostedCredentialBackend } from './credentials.js';

export interface HostedManifestCache {
  fetchedAt: string;
  manifest: unknown;
}

export type WebcmdConfig =
  | {
      mode: 'local';
      updatedAt: string;
    }
  | {
      mode: 'hosted';
      updatedAt: string;
      hosted: {
        apiBaseUrl: string;
        apiKey?: string;
        apiKeyRef?: string;
        credentialBackend?: HostedCredentialBackend;
        manifestCache?: HostedManifestCache;
      };
    };

export interface ConfigIo {
  readFileSync?: typeof fs.readFileSync;
  writeFileSync?: typeof fs.writeFileSync;
  mkdirSync?: typeof fs.mkdirSync;
  chmodSync?: typeof fs.chmodSync;
  existsSync?: typeof fs.existsSync;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => Date;
}

export function getConfigDir(io: Pick<ConfigIo, 'env' | 'homeDir'> = {}): string {
  const env = io.env ?? process.env;
  return env[`${ENV_PREFIX}_CONFIG_DIR`] || path.join(io.homeDir ?? os.homedir(), CONFIG_DIR_NAME);
}

export function getConfigPath(io: Pick<ConfigIo, 'env' | 'homeDir'> = {}): string {
  return path.join(getConfigDir(io), 'config.json');
}

function parseConfig(raw: string): WebcmdConfig {
  const parsed = JSON.parse(raw) as Partial<WebcmdConfig>;
  if (parsed.mode === 'local' && typeof parsed.updatedAt === 'string') {
    return { mode: 'local', updatedAt: parsed.updatedAt };
  }
  if (
    parsed.mode === 'hosted'
    && typeof parsed.updatedAt === 'string'
    && typeof parsed.hosted?.apiBaseUrl === 'string'
    && (typeof parsed.hosted?.apiKey === 'string' || typeof parsed.hosted?.apiKeyRef === 'string')
  ) {
    const credentialBackend = readCredentialBackend(parsed.hosted.credentialBackend);
    return {
      mode: 'hosted',
      updatedAt: parsed.updatedAt,
      hosted: {
        apiBaseUrl: parsed.hosted.apiBaseUrl,
        ...(typeof parsed.hosted.apiKey === 'string' ? { apiKey: parsed.hosted.apiKey } : {}),
        ...(typeof parsed.hosted.apiKeyRef === 'string' ? { apiKeyRef: parsed.hosted.apiKeyRef } : {}),
        ...(credentialBackend ? { credentialBackend } : {}),
        ...(parsed.hosted.manifestCache ? { manifestCache: parsed.hosted.manifestCache } : {}),
      },
    };
  }
  return { mode: 'local', updatedAt: new Date(0).toISOString() };
}

export function loadWebcmdConfig(io: ConfigIo = {}): WebcmdConfig {
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  try {
    return parseConfig(readFileSync(getConfigPath(io), 'utf-8') as string);
  } catch {
    return { mode: 'local', updatedAt: new Date(0).toISOString() };
  }
}

export function saveWebcmdConfig(config: WebcmdConfig, io: ConfigIo = {}): void {
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const mkdirSync = io.mkdirSync ?? fs.mkdirSync;
  const chmodSync = io.chmodSync ?? fs.chmodSync;
  const target = getConfigPath(io);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(persistableConfig(config), null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(target, 0o600);
  } catch {
    // Windows and unusual filesystems may not support POSIX modes.
  }
}

export type LocalWebcmdConfig = Extract<WebcmdConfig, { mode: 'local' }>;
export type HostedWebcmdConfig = Extract<WebcmdConfig, { mode: 'hosted' }>;

export function makeLocalConfig(now: Date = new Date()): LocalWebcmdConfig {
  return {
    mode: 'local',
    updatedAt: now.toISOString(),
  };
}

export function makeHostedConfig(input: {
  apiBaseUrl: string;
  apiKey?: string;
  apiKeyRef?: string;
  credentialBackend?: HostedCredentialBackend;
  manifestCache?: HostedManifestCache;
  now?: Date;
}): HostedWebcmdConfig {
  return {
    mode: 'hosted',
    updatedAt: (input.now ?? new Date()).toISOString(),
    hosted: {
      apiBaseUrl: normalizeApiBaseUrl(input.apiBaseUrl),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey.trim() } : {}),
      ...(input.apiKeyRef !== undefined ? { apiKeyRef: input.apiKeyRef } : {}),
      ...(input.credentialBackend !== undefined ? { credentialBackend: input.credentialBackend } : {}),
      ...(input.manifestCache ? { manifestCache: input.manifestCache } : {}),
    },
  };
}

export function normalizeApiBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  return value || defaultHostedApiBaseUrl();
}

export function defaultHostedApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeConfiguredUrl(env.WEBCMD_CLOUD_API_URL) ?? 'https://api.webcmd.dev';
}

function normalizeConfiguredUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  return raw.trim().replace(/\/+$/, '');
}

export function isHostedConfig(config: WebcmdConfig): config is Extract<WebcmdConfig, { mode: 'hosted' }> {
  return config.mode === 'hosted';
}

export function shouldUseHostedMode(io: ConfigIo = {}): boolean {
  return isHostedConfig(loadWebcmdConfig(io));
}

function readCredentialBackend(value: unknown): HostedCredentialBackend | undefined {
  return value === 'os' || value === 'file-fallback' ? value : undefined;
}

function persistableConfig(config: WebcmdConfig): WebcmdConfig {
  if (config.mode !== 'hosted' || !config.hosted.apiKeyRef) return config;
  return {
    mode: 'hosted',
    updatedAt: config.updatedAt,
    hosted: {
      apiBaseUrl: config.hosted.apiBaseUrl,
      apiKeyRef: config.hosted.apiKeyRef,
      ...(config.hosted.credentialBackend ? { credentialBackend: config.hosted.credentialBackend } : {}),
      ...(config.hosted.manifestCache ? { manifestCache: config.hosted.manifestCache } : {}),
    },
  };
}
