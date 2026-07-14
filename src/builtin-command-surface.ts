import type { Command } from 'commander';

export const LIST_COMMAND_DESCRIPTION = 'List all available CLI commands';
export const LIST_FORMAT_DESCRIPTION = 'Output format: table, json, yaml, md, csv';
export const COMPLETION_COMMAND_DESCRIPTION = 'Output shell completion script';
export const COMPLETION_SHELL_DESCRIPTION = 'Shell type: bash, zsh, or fish';

/** Configure built-in grammar shared by the local and hosted runtimes. */
export function configureListCommandSurface(command: Command): Command {
  return command
    .description(LIST_COMMAND_DESCRIPTION)
    .option('-f, --format <fmt>', LIST_FORMAT_DESCRIPTION, 'table');
}

/** Configure completion grammar shared by the local and hosted runtimes. */
export function configureCompletionCommandSurface(command: Command): Command {
  return command
    .description(COMPLETION_COMMAND_DESCRIPTION)
    .argument('<shell>', COMPLETION_SHELL_DESCRIPTION);
}
