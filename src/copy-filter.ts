import { baseTempDir, debug, ensureArray, generateFinalBasename, normalizePath } from './common.js';
import { isJunk } from 'junk';
import path from 'node:path';
import { isModule, Pruner } from './prune.js';
import { officialPlatformArchCombos } from './targets.js';
import {
  ProcessedOptionsWithSinglePlatformArch,
  OfficialArch,
  OfficialPlatform,
  Options,
  ProcessedOptions,
} from './types.js';
import { CopyOptions } from 'node:fs';

const DEFAULT_IGNORES = [
  '/package-lock\\.json$',
  '/yarn\\.lock$',
  '/pnpm-lock\\.yaml$',
  '/\\.git($|/)',
  '/node_modules/\\.bin($|/)',
  '\\.o(bj)?$',
  '/node_gyp_bins($|/)',
];

export function populateIgnoredPaths(
  opts: Options,
): Pick<ProcessedOptions, 'ignore' | 'originalIgnore'> {
  const originalIgnore = opts.ignore;
  let ignore: ProcessedOptions['ignore'];

  if (typeof opts.ignore !== 'function') {
    const ignoreArray = opts.ignore
      ? [...ensureArray(opts.ignore), ...DEFAULT_IGNORES]
      : [...DEFAULT_IGNORES];
    if (process.platform === 'linux') {
      ignoreArray.push(baseTempDir(opts));
    }
    ignore = ignoreArray;

    debug('Ignored path regular expressions:', ignore);
  } else {
    ignore = opts.ignore;
  }

  return {
    ignore,
    originalIgnore,
  };
}

export function generateIgnoredOutDirs(opts: ProcessedOptionsWithSinglePlatformArch): string[] {
  const normalizedOut = opts.out ? path.resolve(opts.out) : null;
  const ignoredOutDirs: string[] = [];

  if (normalizedOut === null || normalizedOut === process.cwd()) {
    for (const [platform, archs] of Object.entries(officialPlatformArchCombos)) {
      for (const arch of archs) {
        const basenameOpts = {
          arch: arch as OfficialArch,
          name: opts.name,
          platform: platform as OfficialPlatform,
        };
        ignoredOutDirs.push(path.join(process.cwd(), generateFinalBasename(basenameOpts)));
      }
    }
  } else {
    ignoredOutDirs.push(normalizedOut);
  }

  debug('Ignored paths based on the out param:', ignoredOutDirs);

  return ignoredOutDirs;
}

function generateFilterFunction(
  ignore: Exclude<ProcessedOptionsWithSinglePlatformArch['ignore'], undefined>,
): (file: string) => boolean {
  if (typeof ignore === 'function') {
    return (file) => !ignore(file);
  } else {
    const ignoredRegexes = ensureArray(ignore);

    return function filterByRegexes(file) {
      return !ignoredRegexes.some((regex) => file.match(regex));
    };
  }
}

// Operating-system names that prebuild directories start with: Node.js `process.platform` values,
// plus `ios` (used by modules that also target mobile runtimes). A `prebuilds/` subdirectory whose
// name does not start with one of these is not a prebuild target directory.
const PREBUILD_PLATFORMS = new Set([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'ios',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
]);

// `<node_modules path>/<module>/prebuilds/<name>`, for an unscoped or scoped module.
const PREBUILD_DIR = /\/node_modules\/(?:@[^/]+\/)?[^/@][^/]*\/prebuilds\/([^/]+)$/;

/**
 * Whether `name`, a directory directly inside a module's `prebuilds/` directory, holds prebuilt
 * addons that can never be loaded on the given target. Prebuild loaders (`node-gyp-build` for
 * prebuildify, `require-addon` for sodium-native and others) only ever look in
 * `prebuilds/<platform>-<arch>[-<variant>]/`, where the arch part may list several architectures
 * joined by `+` (`darwin-x64+arm64`) and the variant names a libc or simulator flavor
 * (`linux-x64-musl`, `ios-arm64-simulator`). Variants of the target's own platform and arch are
 * kept. `arch` is `null` to keep every architecture of the platform. Names of any other shape are
 * kept.
 */
export function isForeignPrebuildDir(name: string, platform: string, arch: string | null): boolean {
  const [prebuildPlatform, archList, ...variants] = name.split('-');
  if (archList === undefined || !PREBUILD_PLATFORMS.has(prebuildPlatform)) {
    return false;
  }
  const prebuildArches = archList.split('+');
  if ([...prebuildArches, ...variants].some((it) => !/^[a-z0-9]+$/.test(it))) {
    return false;
  }
  if (prebuildPlatform !== platform) {
    return true;
  }
  return arch !== null && !prebuildArches.includes(arch);
}

function foreignPrebuildFilter(
  opts: ProcessedOptionsWithSinglePlatformArch,
): ((name: string) => boolean) | null {
  if (!opts.ignoreForeignPrebuilds) {
    return null;
  }
  // Both slices of a universal build must contain the same files to be merged.
  const arch = opts.universalSliceBuild ? null : opts.arch === 'armv7l' ? 'arm' : opts.arch;
  return (name) => {
    const match = PREBUILD_DIR.exec(name);
    return match !== null && isForeignPrebuildDir(match[1], opts.platform, arch);
  };
}

export function userPathFilter(
  opts: ProcessedOptionsWithSinglePlatformArch,
): CopyOptions['filter'] {
  const filterFunc = generateFilterFunction(opts.ignore || []);
  const ignoredOutDirs = generateIgnoredOutDirs(opts);
  const pruner = opts.prune ? new Pruner(opts.dir, Boolean(opts.quiet)) : null;
  const isForeignPrebuild = foreignPrebuildFilter(opts);

  return async function filter(file) {
    const fullPath = path.resolve(file);

    if (ignoredOutDirs.includes(fullPath)) {
      return false;
    }

    if (opts.junk !== false) {
      // defaults to true
      if (isJunk(path.basename(fullPath))) {
        return false;
      }
    }

    let name = fullPath.split(path.resolve(opts.dir))[1];

    if (path.sep === '\\') {
      name = normalizePath(name);
    }

    if (isForeignPrebuild?.(name)) {
      return false;
    }

    if (pruner && name.startsWith('/node_modules/')) {
      if (await isModule(file)) {
        return pruner.pruneModule(name);
      } else {
        return filterFunc(name);
      }
    }

    return filterFunc(name);
  };
}
