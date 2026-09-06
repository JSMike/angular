/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';
import {NgCompilerAdapter} from '../../core/api';
import {AbsoluteFsPath, absoluteFrom, dirname, isRooted, join, resolve} from '../../file_system';
import {
  createLookupResolutionHost,
  getFailedModuleLookupLocations,
  resolveModuleName,
} from '../../util/src/typescript';

export type ManifestResolutionResult =
  | {
      kind: 'success';
      path: AbsoluteFsPath;
      packageName: string | null;
    }
  | {kind: 'failure'; reason: string};

/** Host views are distinct: an editor source or resource may differ from the file on disk. */
interface FileObservations {
  exists?: boolean;
  directory?: boolean;
  realpath?: string;
  file?: string | null;
  source?: string | null;
  manifest?: string | null;
}

interface ModuleResolution {
  resolvedModule: ts.ResolvedModule | undefined;
  affectingLocations?: readonly string[];
  failedLookupLocations?: readonly string[];
}

const MANIFEST_MARKER = '.$ngcustomelements$';

/**
 * The filesystem boundary for one manifest load. All manifest and declaration resolution uses
 * fresh caches and one dependency ledger. Resource paths additionally notify incremental hosts;
 * file and directory observations validate reuse without creating directory-wide watches.
 */
export class ManifestResolver {
  readonly files = new Map<AbsoluteFsPath, FileObservations>();
  hasConsistentReads = true;
  readonly resolutionPaths = new Set<AbsoluteFsPath>();
  readonly typeModuleResolutionCache: ts.ModuleResolutionCache;
  readonly canCache: boolean;
  private readonly jsonModuleResolutionCache: ts.ModuleResolutionCache;
  private readonly resolutionHost: ts.ModuleResolutionHost &
    Pick<ts.CompilerHost, 'resolveModuleNames'>;
  private readonly host: ts.ModuleResolutionHost & Pick<ts.CompilerHost, 'getCurrentDirectory'>;

  constructor(
    readonly basePath: AbsoluteFsPath,
    readonly options: ts.CompilerOptions,
    readonly adapter: NgCompilerAdapter,
  ) {
    this.resolutionHost = adapter.resourceResolutionHost ?? adapter;
    this.canCache = this.resolutionHost.resolveModuleNames === undefined;
    this.typeModuleResolutionCache = ts.createModuleResolutionCache(
      basePath,
      adapter.getCanonicalFileName.bind(adapter),
      options,
    );
    this.jsonModuleResolutionCache = ts.createModuleResolutionCache(
      basePath,
      adapter.getCanonicalFileName.bind(adapter),
      {...options, resolveJsonModule: true},
    );
    this.host = {
      fileExists: (path) => this.fileExists(path),
      readFile: (path) => this.readFile(path),
      directoryExists:
        adapter.directoryExists === undefined ? undefined : (path) => this.directoryExists(path),
      getDirectories: adapter.getDirectories?.bind(adapter),
      getCurrentDirectory: adapter.getCurrentDirectory.bind(adapter),
      realpath: adapter.realpath === undefined ? undefined : (path) => this.realpath(path),
      trace: adapter.trace?.bind(adapter),
      useCaseSensitiveFileNames:
        typeof adapter.useCaseSensitiveFileNames === 'function'
          ? adapter.useCaseSensitiveFileNames.bind(adapter)
          : adapter.useCaseSensitiveFileNames,
    };
  }

  fileExists(path: string): boolean {
    const exists = this.adapter.fileExists(path);
    this.observe(path, 'exists', exists);
    return exists;
  }

  directoryExists(path: string): boolean {
    const exists = this.adapter.directoryExists?.(path) ?? true;
    this.observe(path, 'directory', exists);
    return exists;
  }

  readFile(path: string): string | undefined {
    const content = this.adapter.readFile(path);
    this.observe(path, 'file', content ?? null);
    return content;
  }

  realpath(path: string): string {
    const resolved = this.adapter.realpath?.(path) ?? path;
    this.observe(path, 'realpath', resolved);
    return resolved;
  }

  /** Consumer sources are authoritative; hosts may also supply unsaved declaration files. */
  getSourceFile(
    path: string,
    languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
    program: ts.Program,
  ): ts.SourceFile | undefined {
    let source = this.readSourceFile(path, languageVersion, program);
    if (source === undefined) {
      const text = this.adapter.readFile(path);
      if (text !== undefined) {
        source = ts.createSourceFile(path, text, languageVersion, true);
      }
    }
    this.observe(path, 'source', source?.text ?? null);
    return source;
  }

  private readSourceFile(
    path: string,
    languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
    program: ts.Program,
  ): ts.SourceFile | undefined {
    return program.getSourceFile(path) ?? this.adapter.getSourceFile(path, languageVersion);
  }

  readManifest(path: AbsoluteFsPath): string | null {
    this.watch(path);
    const content = this.readResource(path);
    this.observe(path, 'manifest', content);
    return content;
  }

  private readResource(path: AbsoluteFsPath): string | null {
    if (this.adapter.readResource !== undefined) {
      const text = this.adapter.readResource(path);
      if (typeof text === 'string') {
        return text === '' && !this.adapter.fileExists(path) ? null : text;
      }
    }
    return this.adapter.fileExists(path) ? (this.adapter.readFile(path) ?? null) : null;
  }

  /** Capture inputs when they are consumed, never by rereading after producing the result. */
  private observe<K extends keyof FileObservations>(
    path: string,
    kind: K,
    value: FileObservations[K],
  ): void {
    const absolutePath = absoluteFrom(path);
    let file = this.files.get(absolutePath);
    if (file === undefined) {
      this.files.set(absolutePath, (file = {}));
    }
    if (file[kind] !== undefined && file[kind] !== value) {
      this.hasConsistentReads = false;
    }
    file[kind] = value;
  }

  /** Validate each observation through the host view that supplied it, including missing paths. */
  matches(files: ReadonlyMap<AbsoluteFsPath, FileObservations>, program: ts.Program): boolean {
    for (const [path, file] of files) {
      if (
        (file.exists !== undefined && this.adapter.fileExists(path) !== file.exists) ||
        (file.directory !== undefined &&
          (this.adapter.directoryExists?.(path) ?? true) !== file.directory) ||
        (file.realpath !== undefined &&
          (this.adapter.realpath?.(path) ?? path) !== file.realpath) ||
        (file.file !== undefined && (this.adapter.readFile(path) ?? null) !== file.file) ||
        (file.source !== undefined &&
          (this.readSourceFile(path, ts.ScriptTarget.Latest, program)?.text ??
            this.adapter.readFile(path) ??
            null) !== file.source) ||
        (file.manifest !== undefined && this.readResource(path) !== file.manifest)
      ) {
        return false;
      }
    }
    return true;
  }

  private watch(path: AbsoluteFsPath): void {
    this.resolutionPaths.add(path);
    this.adapter.recordResourceDependency?.(path);
  }

  /** Resolve the same import contract that will be emitted into the consumer's type-check block. */
  resolveModule(
    specifier: string,
    containingFile: string = join(this.basePath, 'index.ts'),
    mode?: ts.ResolutionMode,
  ): ts.ResolvedModule | undefined {
    return this.resolve(
      specifier,
      containingFile,
      this.options,
      this.typeModuleResolutionCache,
      mode,
    ).resolvedModule;
  }

  private resolve(
    specifier: string,
    containingFile: string,
    options: ts.CompilerOptions,
    cache: ts.ModuleResolutionCache,
    mode?: ts.ResolutionMode,
  ): ModuleResolution {
    if (this.resolutionHost.resolveModuleNames !== undefined) {
      // A custom resolver may depend on state that cannot be observed. Its loads are not cached.
      return {
        resolvedModule: resolveModuleName(
          specifier,
          containingFile,
          options,
          this.resolutionHost,
          cache,
        ),
      };
    }
    const result: ModuleResolution = ts.resolveModuleName(
      specifier,
      containingFile,
      options,
      this.host,
      cache,
      undefined,
      mode ?? ts.getImpliedNodeFormatForFile(containingFile, cache, this.host, options),
    );
    for (const path of result.affectingLocations ?? []) {
      this.watch(absoluteFrom(path));
    }
    return result;
  }

  resolveManifest(entry: string): ManifestResolutionResult {
    const failure = (reason: string): ManifestResolutionResult => ({
      kind: 'failure',
      reason,
    });
    const success = (
      path: AbsoluteFsPath,
      packageName: string | null,
    ): ManifestResolutionResult => ({
      kind: 'success',
      path,
      packageName,
    });
    if (entry.startsWith('./') || entry.startsWith('../') || isRooted(entry)) {
      const path = resolve(this.basePath, entry);
      this.watch(path);
      return this.fileExists(path)
        ? success(path, null)
        : failure(`The file '${path}' does not exist.`);
    }
    if (entry.endsWith('.json')) {
      const path = this.resolveJson(entry);
      const segments = entry.split('/');
      const packageName = entry.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
      return path === null
        ? failure(`The module specifier '${entry}' could not be resolved to a file.`)
        : success(path, packageName);
    }
    let packageJson = this.resolveJson(`${entry}/package.json`);
    if (packageJson === null) {
      const resolved = this.resolveModule(entry);
      if (resolved !== undefined) {
        packageJson = this.findOwningPackageJson(
          dirname(absoluteFrom(resolved.resolvedFileName)),
          entry,
        );
      }
    }
    if (packageJson === null) {
      return failure(`The package '${entry}' could not be resolved.`);
    }
    this.watch(packageJson);
    let customElements: unknown;
    try {
      const content = this.readFile(packageJson);
      customElements =
        content === undefined
          ? undefined
          : (JSON.parse(content) as {[key: string]: unknown})['customElements'];
    } catch {
      return failure(`Failed to parse '${packageJson}' as JSON.`);
    }
    if (typeof customElements !== 'string') {
      return failure(
        `The package '${entry}' does not declare a Custom Elements Manifest: its package.json ` +
          `has no "customElements" field. Specify the path to the manifest file directly instead ` +
          `(e.g. '${entry}/custom-elements.json').`,
      );
    }
    const path = resolve(dirname(packageJson), customElements);
    this.watch(path);
    return this.fileExists(path)
      ? success(path, entry)
      : failure(
          `The "customElements" field of the package.json of '${entry}' points to '${path}', which does not exist.`,
        );
  }

  /** Record every ancestor candidate, including missing or malformed nearer package metadata. */
  findOwningPackageJson(directory: AbsoluteFsPath, packageName: string): AbsoluteFsPath | null {
    while (true) {
      const path = join(directory, 'package.json');
      this.watch(path);
      if (this.fileExists(path)) {
        try {
          if (
            (JSON.parse(this.readFile(path)!) as {[key: string]: unknown})['name'] === packageName
          ) {
            return path;
          }
        } catch {
          // A malformed candidate cannot establish package identity. Continue with its parent.
        }
      }
      const parent = dirname(directory);
      if (parent === directory) {
        return null;
      }
      directory = parent;
    }
  }

  private resolveJson(specifier: string): AbsoluteFsPath | null {
    const containingFile = join(this.basePath, 'index.ts');
    const {resolvedModule, failedLookupLocations} = this.resolve(
      specifier,
      containingFile,
      {...this.options, resolveJsonModule: true},
      this.jsonModuleResolutionCache,
    );
    if (resolvedModule?.resolvedFileName.endsWith('.json')) {
      const path = absoluteFrom(resolvedModule.resolvedFileName);
      this.watch(path);
      return path;
    }
    const candidates = [
      ...(failedLookupLocations ?? []).filter(
        (path) => path.endsWith('.json') && !path.endsWith('/package.json'),
      ),
      ...(
        getFailedModuleLookupLocations(
          specifier,
          containingFile,
          this.options,
          createLookupResolutionHost(this.host, MANIFEST_MARKER),
          MANIFEST_MARKER,
        ) ?? []
      ).filter((path) => path.endsWith(specifier)),
    ];
    for (const candidate of candidates) {
      const path = absoluteFrom(candidate);
      // Observe creation in existing directories without bypassing package exports.
      if (
        this.adapter.directoryExists === undefined
          ? this.fileExists(join(dirname(path), 'package.json'))
          : this.directoryExists(dirname(path))
      ) {
        this.watch(path);
      }
    }
    return null;
  }
}
