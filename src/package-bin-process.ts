import path from 'node:path';

type SpawnOutput = string | Buffer | null | undefined;

export interface PackageBinSpawnFailure {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status: number | null;
  stdout?: SpawnOutput;
  stderr?: SpawnOutput;
}

export function packageBinSpawnOptions(
  platform: NodeJS.Platform,
  command: string,
): { shell?: true } {
  if (platform !== 'win32') return {};
  const basename = path.win32.basename(command).toLowerCase();
  return basename === 'npm' || basename.endsWith('.cmd') ? { shell: true } : {};
}

function outputText(output: SpawnOutput): string {
  return output == null ? '' : output.toString().trim();
}

export function formatPackageBinSpawnFailure(
  command: string,
  args: string[],
  result: PackageBinSpawnFailure,
): string {
  const invocation = [command, ...args].join(' ');
  if (result.error) {
    return `${invocation} failed to start: ${result.error.message}`;
  }

  const outcome = result.status === null
    ? `terminated by ${result.signal ?? 'an unknown signal'}`
    : `exited ${result.status}`;
  return [
    `${invocation} ${outcome}`,
    outputText(result.stdout),
    outputText(result.stderr),
  ].filter(Boolean).join('\n');
}
