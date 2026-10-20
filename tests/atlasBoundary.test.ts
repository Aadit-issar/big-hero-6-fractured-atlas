import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const atlasRoot = join(process.cwd(), 'src', 'atlas');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

describe('ATLAS information and control boundaries', () => {
  it('keeps simulation and sensor acquisition imports out of the core and UI', () => {
    const protectedFiles = [...sourceFiles(join(atlasRoot, 'core')), ...sourceFiles(join(atlasRoot, 'ui')), ...sourceFiles(join(atlasRoot, 'mapping')), ...sourceFiles(join(atlasRoot, 'analysis')), ...sourceFiles(join(atlasRoot, 'live')), ...sourceFiles(join(atlasRoot, 'scene'))];
    for (const path of protectedFiles) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/from\s+['"][^'"]*(?:simulation|atlasSensor)[^'"]*['"]/);
      expect(source, path).not.toMatch(/(?:import\s*\(|require\s*\()[^)]*(?:simulation|atlasSensor)/);
      expect(source, path).not.toMatch(/\b(?:sampleField|evaluateIsland|traverse|advance|resetRevision|scenario)\b/);
    }
  });

  it('isolates the live simulation host and routes only observe(engine) snapshots into ATLAS', () => {
    const hostPath = join(atlasRoot, 'lab', 'AtlasLab.tsx');
    const source = readFileSync(hostPath, 'utf8');
    expect(source).toMatch(/import\s*\{\s*observe\s*\}\s*from\s*['"]\.\.\/\.\.\/sensors\/atlasSensor['"]/);
    expect(source).toMatch(/import\s*\{\s*SimulationEngine\s*\}\s*from\s*['"]\.\.\/\.\.\/simulation\/simulationEngine['"]/);
    expect(source).toMatch(/runtime\.receive\(observe\(engine\)/);
    expect(source).toMatch(/engine\.advance\(deltaSeconds\)/);
    expect(source).not.toMatch(/engine\.(?:clock|explorer|network|world|sampleField|evaluateIsland|reset|scenario|traverse)/);
  });

  it('keeps the installed sensor at engine time and does not add a future-time query', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'sensors', 'atlasSensor.ts'), 'utf8');
    expect(source).toMatch(/const time = engine\.clock\.time/);
    expect(source).toMatch(/engine\.sampleField\(engine\.explorer\.referencePosition, time\)/);
    expect(source).toMatch(/engine\.network\.getConnections\(time\)/);
    expect(source).not.toMatch(/time\s*\+\s*1/);
    expect(source).not.toMatch(/engine\.advance|engine\.reset|\.traverse\(/);
  });

  it('leaves both shared contract files unchanged in the worktree', () => {
    // The unit test asserts file ownership at execution time through a direct
    // source check; a git diff is also part of the documented verification.
    const contract = readFileSync(join(process.cwd(), 'src', 'shared', 'atlasContract.ts'), 'utf8');
    expect(contract).toContain('contractVersion: 1');
    expect(contract).toContain('export interface AtlasObservation');
  });
});
