import {
  generateIgnoredOutDirs,
  isForeignPrebuildDir,
  populateIgnoredPaths,
  userPathFilter,
} from '../src/copy-filter.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { ProcessedOptionsWithSinglePlatformArch, Options } from '../src/types.js';

describe('populateIgnoredPaths', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'electron-packager-test-'));
  });

  it('ignores the generated temporary directory only on Linux', () => {
    const tmpdir = '/foo/bar';
    const expected = path.join(tmpdir, 'electron-packager');
    const opts = { tmpdir } as Options;

    const result = populateIgnoredPaths(opts);

    if (process.platform === 'linux') {
      expect(result.ignore).toContain(expected);
    } else {
      expect(result.ignore).not.toContain(expected);
    }
  });

  it('ignores certain files by default', async () => {
    const opts = {
      name: 'test',
      dir: path.join(__dirname, 'fixtures', 'basic'),
    } as Options;

    const ignoreResult = populateIgnoredPaths(opts);
    const processedOpts = {
      ...opts,
      ...ignoreResult,
    } as ProcessedOptionsWithSinglePlatformArch;
    const targetDir = path.join(tempDir, 'result');
    await fs.promises.cp(opts.dir, targetDir, {
      dereference: false,
      filter: userPathFilter(processedOpts),
      recursive: true,
    });

    expect(fs.existsSync(path.join(targetDir, 'node_gyp_bins'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'ignore.o'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'ignore.obj'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'package-lock.json'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'yarn.lock'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'Thumbs.db'))).toBe(false);

    // Random txt files should not be ignored
    expect(fs.existsSync(path.join(targetDir, 'ignorethis.txt'))).toBe(true);
  });
});

describe('userPathFilter', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'electron-packager-test-'));
  });
  it.each([
    ['string', 'ignorethis'],
    ['string in array', ['ignorethis']],
    ['RegExp', /ignorethis/],
    ['Function', (file: string) => file.match(/ignorethis/)],
  ])('ignores %s that match the ignore pattern', async (_, ignore) => {
    const opts = {
      name: 'test',
      dir: path.join(__dirname, 'fixtures', 'basic'),
      ignore: ignore,
    } as Options;

    populateIgnoredPaths(opts);
    const targetDir = path.join(tempDir, 'result');
    await fs.promises.cp(opts.dir, targetDir, {
      dereference: false,
      filter: userPathFilter(opts as ProcessedOptionsWithSinglePlatformArch),
      recursive: true,
    });

    expect(fs.existsSync(path.join(targetDir, 'ignorethis.txt'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'ignore', 'this.txt'))).toBe(true);
  });

  it('parses slashes in the ignore pattern', async () => {
    const opts = {
      name: 'test',
      dir: path.join(__dirname, 'fixtures', 'basic'),
      ignore: ['ignore/this'],
    } as Options;

    populateIgnoredPaths(opts);
    const targetDir = path.join(tempDir, 'result');
    await fs.promises.cp(opts.dir, targetDir, {
      dereference: false,
      filter: userPathFilter(opts as ProcessedOptionsWithSinglePlatformArch),
      recursive: true,
    });

    expect(fs.existsSync(path.join(targetDir, 'ignorethis.txt'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'ignore', 'this.txt'))).toBe(false);
  });

  it('only ignores files within the app directory', async () => {
    const opts = {
      name: 'test',
      dir: path.join(__dirname, 'fixtures', 'basic'),
      // we're testing to see that not all files are ignored from the source dir if a parent directory is in the ignore list
      ignore: [__dirname],
    } as Options;

    populateIgnoredPaths(opts);

    const targetDir = path.join(tempDir, 'result');
    await fs.promises.cp(opts.dir, targetDir, {
      dereference: false,
      filter: userPathFilter(opts as ProcessedOptionsWithSinglePlatformArch),
      recursive: true,
    });

    expect(fs.existsSync(path.join(targetDir, 'package.json'))).toBe(true);
  });

  it.each([
    ['junk: true', true],
    ['junk: false', false],
  ])('respects %s', async (_, junk) => {
    const opts = {
      name: 'test',
      dir: path.join(__dirname, 'fixtures', 'ignore-junk'),
      junk,
    } as Options;

    populateIgnoredPaths(opts);

    const targetDir = path.join(tempDir, 'result');
    await fs.promises.cp(opts.dir, targetDir, {
      dereference: false,
      filter: userPathFilter(opts as ProcessedOptionsWithSinglePlatformArch),
      recursive: true,
    });

    expect(fs.existsSync(path.join(targetDir, 'subfolder', 'Thumbs.db'))).toBe(!junk);
  });
});

describe('generateIgnoredOutDirs', () => {
  it('ignores all possible platform/arch permutations', () => {
    const ignores = generateIgnoredOutDirs({
      name: 'test',
    } as ProcessedOptionsWithSinglePlatformArch);
    const relativeIgnores = ignores.map((ignore) => path.relative(process.cwd(), ignore));
    expect(relativeIgnores).toMatchSnapshot();
  });
});

describe('isForeignPrebuildDir', () => {
  it.each([
    // the target's own directory, including fat macOS prebuilds
    ['linux-x64', 'linux', 'x64', false],
    ['win32-x64', 'win32', 'x64', false],
    ['darwin-x64+arm64', 'darwin', 'arm64', false],
    ['linux-arm', 'linux', 'arm', false],
    // another architecture of the target platform
    ['linux-arm64', 'linux', 'x64', true],
    ['win32-ia32', 'win32', 'x64', true],
    // another platform
    ['darwin-x64+arm64', 'linux', 'x64', true],
    ['android-arm', 'win32', 'x64', true],
    // universal slices (no arch) keep every architecture of the platform
    ['darwin-x64', 'darwin', null, false],
    ['linux-x64', 'darwin', null, true],
    // names that are not node-gyp-build target directories are kept
    ['README.md', 'win32', 'x64', false],
    ['foo-bar', 'win32', 'x64', false],
    ['linux-x64.tar.gz', 'win32', 'x64', false],
    ['-x64', 'win32', 'x64', false],
  ])('%s for %s-%s is foreign: %s', (name, platform, arch, expected) => {
    expect(isForeignPrebuildDir(name, platform, arch)).toBe(expected);
  });
});

describe('ignoreForeignPrebuilds', () => {
  const PREBUILDS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
  let appDir: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'electron-packager-test-'));
    appDir = path.join(tempDir, 'app');
    await fs.promises.mkdir(appDir);
    await fs.promises.writeFile(
      path.join(appDir, 'package.json'),
      '{"name":"app","dependencies":{"addon":"1.0.0","@scope/addon":"1.0.0"}}',
    );
    for (const moduleName of ['addon', '@scope/addon']) {
      const moduleDir = path.join(appDir, 'node_modules', moduleName);
      for (const target of PREBUILDS) {
        await fs.promises.mkdir(path.join(moduleDir, 'prebuilds', target), { recursive: true });
        await fs.promises.writeFile(
          path.join(moduleDir, 'prebuilds', target, 'addon.node'),
          target,
        );
      }
      await fs.promises.writeFile(path.join(moduleDir, 'prebuilds', 'notes.txt'), '');
      // only a module's own prebuilds/ directory is what node-gyp-build loads from
      await fs.promises.mkdir(path.join(moduleDir, 'lib', 'prebuilds', 'win32-x64'), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(moduleDir, 'lib', 'prebuilds', 'win32-x64', 'data.bin'),
        '',
      );
      await fs.promises.writeFile(path.join(moduleDir, 'package.json'), `{"name":"${moduleName}"}`);
    }
  });

  async function copiedPrebuilds(opts: Partial<ProcessedOptionsWithSinglePlatformArch>) {
    const fullOpts = {
      name: 'test',
      dir: appDir,
      prune: false,
      ...opts,
    } as ProcessedOptionsWithSinglePlatformArch;
    Object.assign(fullOpts, populateIgnoredPaths(fullOpts));
    const targetDir = path.join(tempDir, 'result');
    await fs.promises.cp(appDir, targetDir, {
      dereference: false,
      filter: userPathFilter(fullOpts),
      recursive: true,
    });
    const result: Record<string, string[]> = {};
    for (const moduleName of ['addon', '@scope/addon']) {
      const moduleDir = path.join(targetDir, 'node_modules', moduleName);
      result[moduleName] = (await fs.promises.readdir(path.join(moduleDir, 'prebuilds'))).sort();
      expect(fs.existsSync(path.join(moduleDir, 'lib', 'prebuilds', 'win32-x64', 'data.bin'))).toBe(
        true,
      );
    }
    return result;
  }

  it('copies every prebuild by default', async () => {
    const result = await copiedPrebuilds({ platform: 'linux', arch: 'x64' });
    expect(result['addon']).toEqual([...PREBUILDS, 'notes.txt'].sort());
    expect(result['@scope/addon']).toEqual([...PREBUILDS, 'notes.txt'].sort());
  });

  it('copies only the target prebuild when enabled', async () => {
    const result = await copiedPrebuilds({
      platform: 'linux',
      arch: 'x64',
      ignoreForeignPrebuilds: true,
    });
    expect(result['addon']).toEqual(['linux-x64', 'notes.txt']);
    expect(result['@scope/addon']).toEqual(['linux-x64', 'notes.txt']);
  });

  it('keeps every macOS architecture in a universal slice', async () => {
    const result = await copiedPrebuilds({
      platform: 'darwin',
      arch: 'arm64',
      universalSliceBuild: true,
      ignoreForeignPrebuilds: true,
    });
    expect(result['addon']).toEqual(['darwin-arm64', 'darwin-x64', 'notes.txt']);
  });
});
