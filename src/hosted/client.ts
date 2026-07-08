import { CliError, EXIT_CODES, type ExitCode } from '../errors.js';
import type { HostedErrorResponse, HostedExecuteResponse, HostedManifest } from './types.js';

export interface HostedClientOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class HostedClientError extends CliError {
  constructor(code: string, message: string, help?: string, exitCode: ExitCode = EXIT_CODES.GENERIC_ERROR) {
    super(code, message, help, exitCode);
  }
}

export class HostedClient {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HostedClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getMe(): Promise<unknown> {
    return this.request('/v1/me');
  }

  async getManifest(): Promise<HostedManifest> {
    const body = await this.request('/v1/manifest') as { manifest?: HostedManifest };
    if (!body.manifest || !Array.isArray(body.manifest.commands)) {
      throw new HostedClientError('HOSTED_PROTOCOL', 'Webcmd Cloud returned an invalid manifest.');
    }
    return body.manifest;
  }

  async execute(input: {
    command: string;
    args: Record<string, unknown>;
    format?: string;
    trace?: string;
    profile?: string;
  }): Promise<HostedExecuteResponse> {
    return this.request('/v1/execute', {
      method: 'POST',
      body: JSON.stringify(input),
    }) as Promise<HostedExecuteResponse>;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${this.apiKey}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const body = text ? parseJson(text) : {};
    if (!response.ok || isHostedError(body)) {
      const error = isHostedError(body)
        ? body.error
        : { code: `HTTP_${response.status}`, message: `Webcmd Cloud request failed with HTTP ${response.status}.` };
      throw new HostedClientError(
        error.code || `HTTP_${response.status}`,
        error.message || `Webcmd Cloud request failed with HTTP ${response.status}.`,
        error.help ?? error.hint,
        normalizeExitCode(error.exitCode, response.status === 401 ? EXIT_CODES.NOPERM : EXIT_CODES.GENERIC_ERROR),
      );
    }
    return body;
  }
}

function normalizeExitCode(value: number | undefined, fallback: ExitCode): ExitCode {
  const allowed = new Set<number>(Object.values(EXIT_CODES));
  return value !== undefined && allowed.has(value) ? value as ExitCode : fallback;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HostedClientError('HOSTED_PROTOCOL', 'Webcmd Cloud returned non-JSON response.');
  }
}

function isHostedError(value: unknown): value is HostedErrorResponse {
  return !!value
    && typeof value === 'object'
    && (value as { ok?: unknown }).ok === false
    && typeof (value as { error?: unknown }).error === 'object';
}
