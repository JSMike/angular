/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';

import {NgCompilerAdapter} from '../../core/api';
import {
  AbsoluteFsPath,
  absoluteFrom,
  dirname,
  isRooted,
  join,
  relative,
  resolve,
} from '../../file_system';
import {
  createLookupResolutionHost,
  getFailedModuleLookupLocations,
  resolveModuleName,
} from '../../util/src/typescript';

export enum ManifestResolutionKind {
  Success,
  Failed,
}

/** Result of resolving a `customElementsManifests` option entry to a manifest file. */
export type ManifestResolutionResult =
  | {
      kind: ManifestResolutionKind.Success;
      path: AbsoluteFsPath;
      /** Owning npm package name, or `null` for a relative/absolute file path entry. */
      packageName: string | null;
      /**
       * Directory of the manifest relative to its owning package root (e.g. `'dist'`), or `''`
       * when at the package root or for non-package entries.
       */
      manifestRelativeDir: string;
      /** Files whose changes can alter this resolution, including the resolved manifest. */
      resolutionPaths: Set<AbsoluteFsPath>;
    }
  | {kind: ManifestResolutionKind.Failed; reason: string; resolutionPaths: Set<AbsoluteFsPath>};

const MANIFEST_MARKER = '.$ngcustomelements$';

/** Extracts the package name from a module specifier such as `@my/lib/custom-elements.json`. */
function packageNameOfSpecifier(specifier: string): string | null {
  const segments = specifier.split('/');
  const packageName = specifier.startsWith('@')
    ? segments.length >= 2
      ? `${segments[0]}/${segments[1]}`
      : null
    : (segments[0] ?? null);
  return packageName !== null && packageName.length > 0 ? packageName : null;
}

/**
 * Resolves a `customElementsManifests` entry to an absolute manifest path. An entry is one of:
 *  - A path starting with `./` or `../` (relative to `basePath`), or an absolute path.
 *  - A `.json` module specifier such as `@my/lib/custom-elements.json`.
 *  - A package name such as `@my/lib`, whose `package.json` has a `customElements` field.
 */
export function resolveCustomElementsManifest(
  entry: string,
  basePath: AbsoluteFsPath,
  options: ts.CompilerOptions,
  adapter: NgCompilerAdapter,
  moduleResolutionCache: ts.ModuleResolutionCache | null,
): ManifestResolutionResult {
  if (entry.startsWith('./') || entry.startsWith('../') || isRooted(entry)) {
    const path = resolve(basePath, entry);
    adapter.recordResourceDependency?.(path);
    if (adapter.fileExists(path)) {
      return {
        kind: ManifestResolutionKind.Success,
        path,
        packageName: null,
        manifestRelativeDir: '',
        resolutionPaths: new Set([path]),
      };
    }
    const base = isRooted(entry)
      ? ''
      : ` Relative entries resolve against the project directory '${basePath}', including ` +
        `entries inherited through "extends".`;
    return {
      kind: ManifestResolutionKind.Failed,
      reason: `The file '${path}' does not exist.${base}`,
      resolutionPaths: new Set([path]),
    };
  }

  if (entry.endsWith('.json')) {
    const resolution = resolveJsonSpecifier(
      entry,
      basePath,
      options,
      adapter,
      moduleResolutionCache,
    );
    if (resolution.path !== null) {
      resolution.resolutionPaths.add(resolution.path);
      const packageName = packageNameOfSpecifier(entry);
      const packageJsonPath =
        packageName === null
          ? null
          : findOwningPackageJson(
              dirname(resolution.path),
              packageName,
              adapter,
              resolution.resolutionPaths,
            );
      return {
        kind: ManifestResolutionKind.Success,
        path: resolution.path,
        packageName,
        manifestRelativeDir:
          packageJsonPath === null
            ? ''
            : normalizeRelativeDir(relative(dirname(packageJsonPath), dirname(resolution.path))),
        resolutionPaths: resolution.resolutionPaths,
      };
    }
    const projectFile = resolve(basePath, entry);
    const projectFileExists = adapter.fileExists(projectFile);
    const hint = projectFileExists
      ? ` Entries that do not start with './' or '../' are module specifiers. To load the ` +
        `project file '${projectFile}', use './${entry}'.`
      : '';
    return {
      kind: ManifestResolutionKind.Failed,
      reason: `The module specifier '${entry}' does not resolve to a file.${hint}`,
      resolutionPaths: resolution.resolutionPaths,
    };
  }

  // Package name: read the manifest path from its `package.json`'s `customElements` field.
  const packageJsonResolution = resolveJsonSpecifier(
    `${entry}/package.json`,
    basePath,
    options,
    adapter,
    moduleResolutionCache,
  );
  let packageJsonPath = packageJsonResolution.path;
  if (packageJsonPath === null) {
    packageJsonPath = resolvePackageJsonFromEntrypoint(
      entry,
      basePath,
      options,
      adapter,
      moduleResolutionCache,
      packageJsonResolution.resolutionPaths,
    );
  }
  if (packageJsonPath === null) {
    return {
      kind: ManifestResolutionKind.Failed,
      reason: `The package '${entry}' cannot be resolved from '${basePath}'. Check that it is installed.`,
      resolutionPaths: packageJsonResolution.resolutionPaths,
    };
  }
  packageJsonResolution.resolutionPaths.add(packageJsonPath);

  const packageJsonContent = adapter.readFile(packageJsonPath);
  let customElementsField: unknown;
  try {
    customElementsField =
      packageJsonContent !== undefined
        ? (JSON.parse(packageJsonContent) as {[key: string]: unknown})['customElements']
        : undefined;
  } catch {
    return {
      kind: ManifestResolutionKind.Failed,
      reason: `The file '${packageJsonPath}' is not valid JSON.`,
      resolutionPaths: packageJsonResolution.resolutionPaths,
    };
  }
  if (typeof customElementsField !== 'string') {
    return {
      kind: ManifestResolutionKind.Failed,
      reason:
        `The package.json of '${entry}' ('${packageJsonPath}') has no "customElements" field, so ` +
        `the package does not say where its manifest is. Configure the manifest file instead, ` +
        `such as '${entry}/custom-elements.json'.`,
      resolutionPaths: packageJsonResolution.resolutionPaths,
    };
  }

  const packageDir = dirname(packageJsonPath);
  const manifestPath = resolve(packageDir, customElementsField);
  adapter.recordResourceDependency?.(manifestPath);
  packageJsonResolution.resolutionPaths.add(manifestPath);
  if (!adapter.fileExists(manifestPath)) {
    return {
      kind: ManifestResolutionKind.Failed,
      reason:
        `The "customElements" field in '${packageJsonPath}' points to '${manifestPath}', which ` +
        `does not exist.`,
      resolutionPaths: packageJsonResolution.resolutionPaths,
    };
  }
  return {
    kind: ManifestResolutionKind.Success,
    path: manifestPath,
    packageName: entry,
    manifestRelativeDir: normalizeRelativeDir(relative(packageDir, dirname(manifestPath))),
    resolutionPaths: packageJsonResolution.resolutionPaths,
  };
}

function normalizeRelativeDir(rel: string): string {
  const normalized = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized === '' || normalized === '.' || normalized.startsWith('..') ? '' : normalized;
}

function resolveResourceModule(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  adapter: NgCompilerAdapter,
  cache: ts.ModuleResolutionCache | null,
): {
  resolvedModule: ts.ResolvedModule | undefined;
  affectingLocations: readonly string[];
  failedLookupLocations: readonly string[];
} {
  const host = adapter.resourceResolutionHost ?? adapter;
  if (host.resolveModuleNames !== undefined) {
    return {
      resolvedModule: resolveModuleName(specifier, containingFile, options, host, cache),
      affectingLocations: [],
      failedLookupLocations: [],
    };
  }
  const resolution = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    host,
    cache ?? undefined,
    undefined,
    ts.getImpliedNodeFormatForFile(containingFile, cache ?? undefined, host, options),
  ) as ts.ResolvedModuleWithFailedLookupLocations & {
    readonly affectingLocations?: readonly string[];
    readonly failedLookupLocations?: readonly string[];
  };
  return {
    resolvedModule: resolution.resolvedModule,
    affectingLocations: resolution.affectingLocations ?? [],
    failedLookupLocations: resolution.failedLookupLocations ?? [],
  };
}

function resolvePackageJsonFromEntrypoint(
  packageName: string,
  basePath: AbsoluteFsPath,
  options: ts.CompilerOptions,
  adapter: NgCompilerAdapter,
  moduleResolutionCache: ts.ModuleResolutionCache | null,
  candidatePaths: Set<AbsoluteFsPath>,
): AbsoluteFsPath | null {
  const {resolvedModule, affectingLocations} = resolveResourceModule(
    packageName,
    join(basePath, 'index.ts'),
    options,
    adapter,
    moduleResolutionCache,
  );
  for (const location of affectingLocations) {
    const abs = absoluteFrom(location);
    candidatePaths.add(abs);
    adapter.recordResourceDependency?.(abs);
  }
  if (resolvedModule === undefined) {
    return null;
  }
  return findOwningPackageJson(
    dirname(absoluteFrom(resolvedModule.resolvedFileName)),
    packageName,
    adapter,
    candidatePaths,
  );
}

function findOwningPackageJson(
  startDirectory: AbsoluteFsPath,
  packageName: string,
  adapter: NgCompilerAdapter,
  candidatePaths: Set<AbsoluteFsPath>,
): AbsoluteFsPath | null {
  let directory = startDirectory;
  while (true) {
    const packageJsonPath = join(directory, 'package.json');
    candidatePaths.add(packageJsonPath);
    const content = adapter.fileExists(packageJsonPath) ? adapter.readFile(packageJsonPath) : null;
    if (typeof content === 'string') {
      try {
        if ((JSON.parse(content) as {[key: string]: unknown})['name'] === packageName) {
          return packageJsonPath;
        }
      } catch {
        // Keep walking up.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

function resolveJsonSpecifier(
  specifier: string,
  basePath: AbsoluteFsPath,
  options: ts.CompilerOptions,
  adapter: NgCompilerAdapter,
  moduleResolutionCache: ts.ModuleResolutionCache | null,
): {path: AbsoluteFsPath | null; resolutionPaths: Set<AbsoluteFsPath>} {
  const containingFile = join(basePath, 'index.ts');
  const resolutionPaths = new Set<AbsoluteFsPath>();
  const {resolvedModule, affectingLocations, failedLookupLocations} = resolveResourceModule(
    specifier,
    containingFile,
    {...options, resolveJsonModule: true},
    adapter,
    moduleResolutionCache,
  );
  for (const location of affectingLocations) {
    const abs = absoluteFrom(location);
    resolutionPaths.add(abs);
    adapter.recordResourceDependency?.(abs);
  }
  if (resolvedModule !== undefined && resolvedModule.resolvedFileName.endsWith('.json')) {
    const path = absoluteFrom(resolvedModule.resolvedFileName);
    resolutionPaths.add(path);
    return {path, resolutionPaths};
  }
  const candidates = [
    ...failedLookupLocations.filter(
      (candidate) => candidate.endsWith('.json') && !candidate.endsWith('/package.json'),
    ),
    ...(
      getFailedModuleLookupLocations(
        specifier,
        containingFile,
        options,
        createLookupResolutionHost(adapter, MANIFEST_MARKER),
        MANIFEST_MARKER,
      ) ?? []
    ).filter((candidate) => candidate.endsWith(specifier)),
  ];
  for (const candidate of candidates) {
    const path = absoluteFrom(candidate);
    if (
      adapter.directoryExists?.(dirname(path)) ??
      adapter.fileExists(join(dirname(path), 'package.json'))
    ) {
      resolutionPaths.add(path);
      adapter.recordResourceDependency?.(path);
    }
  }
  return {path: null, resolutionPaths};
}
