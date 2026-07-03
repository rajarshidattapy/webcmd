import { describe, expect, it, vi } from 'vitest';
import type { ReleaseContext } from './release-notes.js';
import { runGenerateReleaseNotes } from '../scripts/generate-release-notes.js';

function createIo() {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      writeStdout(chunk: string) {
        stdout += chunk;
      },
      writeStderr(chunk: string) {
        stderr += chunk;
      },
    },
    read() {
      return { stdout, stderr };
    },
  };
}

describe('runGenerateReleaseNotes', () => {
  it('exits 1 with usage text when the tag argument is missing', async () => {
    const { io, read } = createIo();

    const exitCode = await runGenerateReleaseNotes(['node', 'script'], {}, {}, io);

    expect(exitCode).toBe(1);
    expect(read()).toEqual({
      stdout: '',
      stderr: 'Usage: generate-release-notes <tag>\n',
    });
  });

  it('exits 0 and leaves stdout empty when GEMINI_API_KEY is missing', async () => {
    const { io, read } = createIo();

    const exitCode = await runGenerateReleaseNotes(['node', 'script', 'v0.0.0'], {}, {}, io);

    expect(exitCode).toBe(0);
    expect(read()).toEqual({
      stdout: '',
      stderr: 'GEMINI_API_KEY is not set; leaving release-please notes unchanged.\n',
    });
  });

  it('normalizes generated markdown before printing it to stdout', async () => {
    const { io, read } = createIo();
    const context: ReleaseContext = {
      tag: 'v1.2.3',
      previousTag: 'v1.2.2',
      currentRef: 'abcdef1',
      pullRequests: [
        {
          number: 42,
          title: 'feat: improve release notes',
          author: { login: 'alice' },
          labels: [],
          files: [],
          url: 'https://example.com/42',
        },
      ],
    };
    const loadContext = vi.fn(async () => context);
    const generateText = vi.fn(async () => '## Highlights\n- Better summaries.');

    const exitCode = await runGenerateReleaseNotes(
      ['node', 'script', 'v1.2.3'],
      { GEMINI_API_KEY: 'test-key' },
      { loadContext, generateText },
      io,
    );

    expect(exitCode).toBe(0);
    expect(loadContext).toHaveBeenCalledWith('v1.2.3', { GEMINI_API_KEY: 'test-key' });
    expect(generateText).toHaveBeenCalledOnce();
    expect(read()).toEqual({
      stdout: [
        '## Highlights',
        '- Better summaries.',
        '',
        '## Improvements',
        'None.',
        '',
        '## Fixes',
        'None.',
        '',
        '## Contributors',
        '- @alice',
        '',
        '## Reverts',
        'None.',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  it('swallows generator errors and keeps release-please notes intact', async () => {
    const { io, read } = createIo();
    const loadContext = vi.fn(async () => {
      throw new Error('gh timed out');
    });

    const exitCode = await runGenerateReleaseNotes(
      ['node', 'script', 'v1.2.3'],
      { GEMINI_API_KEY: 'test-key' },
      { loadContext },
      io,
    );

    expect(exitCode).toBe(0);
    expect(read()).toEqual({
      stdout: '',
      stderr: 'Gemini release notes failed: gh timed out\n',
    });
  });
});
