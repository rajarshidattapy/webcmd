import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkerPath = path.join(packageRoot, 'scripts/check-hosted-contract.mjs');
const artifactNames = ['cli-manifest.json', 'hosted-contract.json'] as const;
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function createCommittedArtifactFixture(): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'webcmd-contract-committed-'));
  fixtureRoots.push(fixtureRoot);
  for (const artifactName of artifactNames) {
    copyFileSync(path.join(packageRoot, artifactName), path.join(fixtureRoot, artifactName));
  }
  return fixtureRoot;
}

function rootArtifactHashes(): Record<string, string> {
  return Object.fromEntries(artifactNames.map((artifactName) => [
    artifactName,
    createHash('sha256').update(readFileSync(path.join(packageRoot, artifactName))).digest('hex'),
  ]));
}

function runChecker(committedRoot: string) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, WEBCMD_CONTRACT_COMMITTED_ROOT: committedRoot },
  });
}

describe('hosted contract reproducibility checker', () => {
  it('accepts byte-identical temporary committed artifacts', () => {
    const result = runChecker(createCommittedArtifactFixture());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Generated contract artifacts match committed bytes.');
  }, 10_000);

  it('rejects one stale byte without mutating root artifacts', () => {
    const before = rootArtifactHashes();
    const fixtureRoot = createCommittedArtifactFixture();
    const stalePath = path.join(fixtureRoot, 'hosted-contract.json');
    const staleBytes = readFileSync(stalePath);
    staleBytes[0] ^= 1;
    writeFileSync(stalePath, staleBytes);

    const result = runChecker(fixtureRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('hosted-contract.json');
    expect(rootArtifactHashes()).toEqual(before);
  }, 10_000);
});
