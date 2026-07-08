export type HostedCommandStrategy = 'PUBLIC' | 'COOKIE' | 'INTERCEPT' | 'UI' | 'LOCAL' | string;

export interface HostedCommandArg {
  name: string;
  type?: string;
  required?: boolean;
  valueRequired?: boolean;
  positional?: boolean;
  default?: unknown;
  help?: string;
  choices?: unknown[];
}

export interface HostedCommand {
  site: string;
  name: string;
  aliases?: string[];
  command: string;
  description: string;
  access: 'read' | 'write' | string;
  strategy: HostedCommandStrategy;
  browser: boolean;
  args: HostedCommandArg[];
  columns?: string[];
  domain?: string | null;
  defaultFormat?: string | null;
}

export interface HostedManifest {
  userId: string;
  generatedAt: string;
  commands: HostedCommand[];
}

export interface HostedExecuteResponse {
  ok: true;
  result?: unknown;
  data?: unknown;
  rows?: unknown;
  columns?: string[];
  trace?: unknown;
}

export interface HostedErrorResponse {
  ok: false;
  error: {
    code?: string;
    message?: string;
    help?: string;
    hint?: string;
    exitCode?: number;
  };
}
