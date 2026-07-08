import yaml from 'js-yaml';
import { ConfigError, EXIT_CODES, toEnvelope } from '../errors.js';
import { render as renderOutput } from '../output.js';
import { HostedClient } from './client.js';
import { parseHostedInvocation } from './args.js';
import {
  findHostedCommand,
  hostedListRows,
  isLocalOnlyHostedCommand,
  renderHostedCommandHelp,
  renderHostedSiteHelp,
  siteNames,
  commandNamesForSite,
} from './manifest.js';
import { isHostedConfig, loadWebcmdConfig, type WebcmdConfig } from './config.js';
import type { HostedManifest } from './types.js';

export interface HostedRunnerOptions {
  config?: WebcmdConfig;
  fetchImpl?: typeof fetch;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface HostedRunResult {
  handled: boolean;
  exitCode: number;
}

export async function runHostedCli(argv: string[], opts: HostedRunnerOptions = {}): Promise<HostedRunResult> {
  const config = opts.config ?? loadWebcmdConfig();
  if (!isHostedConfig(config)) return { handled: false, exitCode: EXIT_CODES.SUCCESS };
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const client = new HostedClient({
    apiBaseUrl: config.hosted.apiBaseUrl,
    apiKey: config.hosted.apiKey,
    fetchImpl: opts.fetchImpl,
  });

  try {
    await dispatchHosted(argv, client, stdout);
    return { handled: true, exitCode: EXIT_CODES.SUCCESS };
  } catch (err) {
    stderr.write(yaml.dump(toEnvelope(err), { sortKeys: false, lineWidth: 120, noRefs: true }));
    return {
      handled: true,
      exitCode: errorExitCode(err),
    };
  }
}

async function dispatchHosted(argv: string[], client: HostedClient, stdout: NodeJS.WritableStream): Promise<void> {
  const normalized = stripGlobalOptions(argv);
  const args = normalized.argv;
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    stdout.write('Usage: webcmd <site> <command> [options]\n       webcmd list\n       webcmd setup\n');
    return;
  }
  if (args[0] === 'daemon') {
    throw new ConfigError(
      'webcmd daemon is local-only. Hosted mode has no local daemon.',
      'Run `webcmd setup` and choose local mode to manage the local daemon.',
    );
  }
  if (args[0] === 'browser') {
    throw new ConfigError(
      'webcmd browser hosted routing is not available in this client slice yet.',
      'Hosted browser parity is implemented by the hosted browser command plan.',
    );
  }

  const manifest = await client.getManifest();
  if (isCompletionRequest(args)) {
    stdout.write(hostedCompletions(manifest, args).join('\n') + '\n');
    return;
  }
  if (args[0] === 'list') {
    renderHostedList(manifest, args.slice(1));
    return;
  }

  const site = args[0]!;
  const commandName = args[1];
  if (!commandName || commandName === '--help' || commandName === '-h') {
    stdout.write(renderHostedSiteHelp(manifest, site));
    return;
  }

  const command = findHostedCommand(manifest, site, commandName);
  if (!command) {
    throw new ConfigError(`Unknown hosted Webcmd command: ${site}/${commandName}`);
  }
  if (isLocalOnlyHostedCommand(command)) {
    throw new ConfigError(
      `Command ${command.command} is local-only and is not available in hosted mode.`,
      'Run `webcmd setup` and choose local mode to use local-only commands.',
    );
  }
  const parsed = parseHostedInvocation(command, [...args.slice(2), ...normalized.trailingCommandOptions]);
  if (parsed.help) {
    stdout.write(renderHostedCommandHelp(command));
    return;
  }

  const response = await client.execute({
    command: command.command,
    args: parsed.args,
    format: parsed.format,
    trace: parsed.trace,
    profile: parsed.profile ?? normalized.profile,
  });
  const result = response.result ?? response.rows ?? response.data ?? null;
  renderOutput(result, {
    fmt: parsed.format,
    fmtExplicit: true,
    columns: response.columns ?? command.columns,
    title: command.command,
    source: 'webcmd cloud',
  });
}

function renderHostedList(manifest: HostedManifest, argv: string[]): void {
  const fmt = readFormat(argv);
  const structured = fmt === 'json' || fmt === 'yaml' || fmt === 'yml';
  renderOutput(hostedListRows(manifest, structured), {
    fmt,
    fmtExplicit: true,
    columns: ['command', 'site', 'name', 'aliases', 'description', 'access', 'strategy', 'browser', 'args',
      ...(structured ? ['columns', 'domain'] : [])],
    title: 'webcmd/list',
    source: 'webcmd cloud',
  });
}

function readFormat(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-f' || argv[i] === '--format') return argv[i + 1] ?? 'table';
    if (argv[i]?.startsWith('--format=')) return argv[i]!.slice('--format='.length);
  }
  return 'table';
}

function stripGlobalOptions(argv: string[]): { argv: string[]; trailingCommandOptions: string[]; profile?: string } {
  const out: string[] = [];
  const trailingCommandOptions: string[] = [];
  let profile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--profile') {
      profile = argv[++i];
      continue;
    }
    if (token.startsWith('--profile=')) {
      profile = token.slice('--profile='.length);
      continue;
    }
    out.push(token);
  }
  return { argv: out, trailingCommandOptions, ...(profile ? { profile } : {}) };
}

function isCompletionRequest(argv: string[]): boolean {
  return argv.includes('--get-completions');
}

function hostedCompletions(manifest: HostedManifest, argv: string[]): string[] {
  const index = argv.indexOf('--get-completions');
  const words = index === -1 ? argv : argv.slice(index + 1).filter((word) => word !== '--cursor');
  const meaningful = words.filter((word) => !/^\d+$/.test(word));
  if (meaningful.length <= 1) return ['list', 'setup', ...siteNames(manifest)];
  return commandNamesForSite(manifest, meaningful[0]!);
}

function errorExitCode(err: unknown): number {
  if (err instanceof ConfigError) return err.exitCode;
  if (err && typeof err === 'object' && 'exitCode' in err && typeof (err as { exitCode?: unknown }).exitCode === 'number') {
    return (err as { exitCode: number }).exitCode;
  }
  return EXIT_CODES.GENERIC_ERROR;
}
