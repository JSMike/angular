/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

const TS = /\.tsx?$/i;
const D_TS = /\.d\.ts$/i;

import ts from 'typescript';
import {AbsoluteFsPath, getFileSystem} from '../../file_system';
import {DeclarationNode} from '../../reflection';

/**
 * Type describing a symbol that is guaranteed to have a value declaration.
 */
export type SymbolWithValueDeclaration = ts.Symbol & {
  valueDeclaration: ts.Declaration;
  declarations: ts.Declaration[];
};

export function isSymbolWithValueDeclaration(
  symbol: ts.Symbol | null | undefined,
): symbol is SymbolWithValueDeclaration {
  // If there is a value declaration set, then the `declarations` property is never undefined. We
  // still check for the property to exist as this matches with the type that `symbol` is narrowed
  // to.
  return (
    symbol != null && symbol.valueDeclaration !== undefined && symbol.declarations !== undefined
  );
}

export function isDtsPath(filePath: string): boolean {
  return D_TS.test(filePath);
}

export function isNonDeclarationTsPath(filePath: string): boolean {
  return TS.test(filePath) && !D_TS.test(filePath);
}

export function isFromDtsFile(node: ts.Node): boolean {
  let sf: ts.SourceFile | undefined = node.getSourceFile();
  if (sf === undefined) {
    sf = ts.getOriginalNode(node).getSourceFile();
  }
  return sf !== undefined && sf.isDeclarationFile;
}

export function nodeNameForError(node: ts.Node & {name?: ts.Node}): string {
  if (node.name !== undefined && ts.isIdentifier(node.name)) {
    return node.name.text;
  } else {
    const kind = ts.SyntaxKind[node.kind];
    const {line, character} = ts.getLineAndCharacterOfPosition(
      node.getSourceFile(),
      node.getStart(),
    );
    return `${kind}@${line}:${character}`;
  }
}

export function getSourceFile(node: ts.Node): ts.SourceFile {
  // In certain transformation contexts, `ts.Node.getSourceFile()` can actually return `undefined`,
  // despite the type signature not allowing it. In that event, get the `ts.SourceFile` via the
  // original node instead (which works).
  const directSf = node.getSourceFile() as ts.SourceFile | undefined;
  return directSf !== undefined ? directSf : ts.getOriginalNode(node).getSourceFile();
}

export function getSourceFileOrNull(
  program: ts.Program,
  fileName: AbsoluteFsPath,
): ts.SourceFile | null {
  return program.getSourceFile(fileName) || null;
}

export function getTokenAtPosition(sf: ts.SourceFile, pos: number): ts.Node {
  // getTokenAtPosition is part of TypeScript's private API.
  return (ts as any).getTokenAtPosition(sf, pos);
}

export function identifierOfNode(decl: ts.Node & {name?: ts.Node}): ts.Identifier | null {
  if (decl.name !== undefined && ts.isIdentifier(decl.name)) {
    return decl.name;
  } else {
    return null;
  }
}

export function isDeclaration(node: ts.Node): node is ts.Declaration {
  return isValueDeclaration(node) || isTypeDeclaration(node);
}

export function isValueDeclaration(
  node: ts.Node,
): node is ts.ClassDeclaration | ts.FunctionDeclaration | ts.VariableDeclaration {
  return (
    ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)
  );
}

export function isTypeDeclaration(
  node: ts.Node,
): node is ts.EnumDeclaration | ts.TypeAliasDeclaration | ts.InterfaceDeclaration {
  return (
    ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)
  );
}

export function isNamedDeclaration(node: ts.Node): node is ts.Declaration & {name: ts.Identifier} {
  const namedNode = node as {name?: ts.Identifier};
  return namedNode.name !== undefined && ts.isIdentifier(namedNode.name);
}

export function isExported(node: DeclarationNode): boolean {
  let topLevel: ts.Node = node;
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
    topLevel = node.parent.parent;
  }
  const modifiers = ts.canHaveModifiers(topLevel) ? ts.getModifiers(topLevel) : undefined;
  return (
    modifiers !== undefined &&
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

export function getRootDirs(
  host: Pick<ts.CompilerHost, 'getCurrentDirectory' | 'getCanonicalFileName'>,
  options: ts.CompilerOptions,
): AbsoluteFsPath[] {
  const rootDirs: string[] = [];
  const cwd = host.getCurrentDirectory();
  const fs = getFileSystem();
  if (options.rootDirs !== undefined) {
    rootDirs.push(...options.rootDirs);
  } else if (options.rootDir !== undefined) {
    rootDirs.push(options.rootDir);
  } else {
    rootDirs.push(cwd);
  }

  // In Windows the above might not always return posix separated paths
  // See:
  // https://github.com/Microsoft/TypeScript/blob/3f7357d37f66c842d70d835bc925ec2a873ecfec/src/compiler/sys.ts#L650
  // Also compiler options might be set via an API which doesn't normalize paths
  return rootDirs.map((rootDir) => fs.resolve(cwd, host.getCanonicalFileName(rootDir)));
}

export function nodeDebugInfo(node: ts.Node): string {
  const sf = getSourceFile(node);
  const {line, character} = ts.getLineAndCharacterOfPosition(sf, node.pos);
  return `[${sf.fileName}: ${ts.SyntaxKind[node.kind]} @ ${line}:${character}]`;
}

/**
 * Resolve the specified `moduleName` using the given `compilerOptions` and `compilerHost`.
 *
 * This helper will attempt to use the `CompilerHost.resolveModuleNames()` method if available.
 * Otherwise it will fallback on the `ts.ResolveModuleName()` function.
 */
export function resolveModuleName(
  moduleName: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
  compilerHost: ts.ModuleResolutionHost & Pick<ts.CompilerHost, 'resolveModuleNames'>,
  moduleResolutionCache: ts.ModuleResolutionCache | null,
): ts.ResolvedModule | undefined {
  if (compilerHost.resolveModuleNames) {
    return compilerHost.resolveModuleNames(
      [moduleName],
      containingFile,
      undefined, // reusedNames
      undefined, // redirectedReference
      compilerOptions,
    )[0];
  } else {
    return ts.resolveModuleName(
      moduleName,
      containingFile,
      compilerOptions,
      compilerHost,
      moduleResolutionCache !== null ? moduleResolutionCache : undefined,
    ).resolvedModule;
  }
}

/** Returns true if the node is an assignment expression. */
export function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/**
 * Asserts that the keys `K` form a subset of the keys of `T`.
 */
export type SubsetOfKeys<T, K extends keyof T> = K;

/**
 * Represents the type `T`, with a transformation applied that turns all methods (even optional
 * ones) into required fields (which may be `undefined`, if the method was optional).
 */
export type RequiredDelegations<T> = {
  [M in keyof Required<T>]: T[M];
};

/**
 * Derives a `ts.ModuleResolutionHost` from a compiler host that recognizes `marker` and avoids
 * filesystem probes for synthetic lookup paths. For use with `getFailedModuleLookupLocations`.
 */
export function createLookupResolutionHost(
  host: ts.ModuleResolutionHost & Pick<ts.CompilerHost, 'getCurrentDirectory'>,
  marker: string,
): RequiredDelegations<ts.ModuleResolutionHost> {
  return {
    directoryExists(directoryName: string): boolean {
      if (directoryName.includes(marker)) {
        return false;
      } else if (host.directoryExists !== undefined) {
        return host.directoryExists(directoryName);
      } else {
        return true;
      }
    },
    fileExists(fileName: string): boolean {
      if (fileName.includes(marker)) {
        return false;
      } else {
        return host.fileExists(fileName);
      }
    },
    readFile: host.readFile.bind(host),
    getCurrentDirectory: host.getCurrentDirectory.bind(host),
    getDirectories: host.getDirectories?.bind(host),
    realpath: host.realpath?.bind(host),
    trace: host.trace?.bind(host),
    useCaseSensitiveFileNames:
      typeof host.useCaseSensitiveFileNames === 'function'
        ? host.useCaseSensitiveFileNames.bind(host)
        : host.useCaseSensitiveFileNames,
  };
}

/**
 * Lists candidate paths where module resolution looks for `specifier` from `containingFile`,
 * outside the TypeScript program, by running a deliberately failing lookup with `marker`.
 */
export function getFailedModuleLookupLocations(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  lookupHost: ts.ModuleResolutionHost,
  marker: string,
): string[] | undefined {
  type ResolvedModuleWithFailedLookupLocations = ts.ResolvedModuleWithFailedLookupLocations & {
    failedLookupLocations?: ReadonlyArray<string>;
  };
  const markerTs = marker + '.ts';
  const failedLookup = ts.resolveModuleName(
    specifier + marker,
    containingFile,
    options,
    lookupHost,
  ) as ResolvedModuleWithFailedLookupLocations;
  return failedLookup.failedLookupLocations
    ?.filter((candidate) => candidate.endsWith(markerTs))
    .map((candidate) => candidate.slice(0, -markerTs.length));
}

/**
 * Source files may become redirects to other source files when their package name and version are
 * identical. TypeScript creates a proxy source file for such source files which has an internal
 * `redirectInfo` property that refers to the original source file.
 */
interface RedirectedSourceFile extends ts.SourceFile {
  redirectInfo?: {unredirected: ts.SourceFile};
}

/**
 * Obtains the non-redirected source file for `sf`.
 */
export function toUnredirectedSourceFile(sf: ts.SourceFile): ts.SourceFile {
  const redirectInfo = (sf as RedirectedSourceFile).redirectInfo;
  if (redirectInfo === undefined) {
    return sf;
  }
  return redirectInfo.unredirected;
}

const TYPECHECK_SHIM_SUFFIX = '.ngtypecheck.ts';

function isTypeCheckShimPath(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(TYPECHECK_SHIM_SUFFIX);
}

/**
 * Checks whether `sf` is reachable from at least one non-shim root, library, or type directive in
 * `program` using TypeScript's internal `getFileIncludeReasons()` map.
 *
 * Excludes both `ShimAdapter`-tagged shims (`isShimFile`) and Language Service `.ngtypecheck.ts`
 * project roots (which do not carry `NgExtension` metadata). Fails closed (`false`) if the
 * internal API or the target's include reasons are unavailable so a TypeScript API change cannot
 * silently restore global augmentation leaks.
 */
export function isFileIncludedByNonShim(
  program: ts.Program,
  sf: ts.SourceFile,
  isShimFile: (file: ts.SourceFile) => boolean,
  getCanonicalFileName: (fileName: string) => string,
  cache?: Map<ts.Path, boolean>,
): boolean {
  if (isShimFile(sf) || isTypeCheckShimPath(sf.fileName)) {
    return false;
  }
  const programWithReasons = program as ts.Program & {
    getFileIncludeReasons?: () => ReadonlyMap<ts.Path, ReadonlyArray<{readonly file?: ts.Path}>>;
    getSourceFileByPath?: (path: ts.Path) => ts.SourceFile | undefined;
  };
  if (typeof programWithReasons.getFileIncludeReasons !== 'function') {
    return false;
  }
  const reasons = programWithReasons.getFileIncludeReasons();
  const resolvePath = (file: ts.SourceFile): ts.Path =>
    (file as ts.SourceFile & {path?: ts.Path}).path ??
    (getCanonicalFileName(file.fileName) as ts.Path);
  let targetPath = resolvePath(sf);
  if (!reasons.has(targetPath)) {
    const unredirected = toUnredirectedSourceFile(sf);
    const unredirectedPath = resolvePath(unredirected);
    if (reasons.has(unredirectedPath)) {
      targetPath = unredirectedPath;
    }
  }
  const cached = cache?.get(targetPath);
  if (cached !== undefined) {
    return cached;
  }
  if (!reasons.has(targetPath)) {
    cache?.set(targetPath, false);
    return false;
  }
  const visited = new Set<ts.Path>([targetPath]);
  const queue: ts.Path[] = [targetPath];
  let reachableFromNonShim = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentReasons = reasons.get(current);
    if (currentReasons === undefined) {
      continue;
    }
    for (const reason of currentReasons) {
      if (reason.file === undefined) {
        reachableFromNonShim = true;
        break;
      }
      if (visited.has(reason.file) || isTypeCheckShimPath(reason.file)) {
        continue;
      }
      const parentSf =
        programWithReasons.getSourceFileByPath?.(reason.file) ?? program.getSourceFile(reason.file);
      if (
        parentSf !== undefined &&
        (isShimFile(parentSf) || isTypeCheckShimPath(parentSf.fileName))
      ) {
        continue;
      }
      visited.add(reason.file);
      queue.push(reason.file);
    }
    if (reachableFromNonShim) {
      break;
    }
  }
  cache?.set(targetPath, reachableFromNonShim);
  return reachableFromNonShim;
}

/**
 * Marker attached to Angular's default `NgCompilerHost` cached `resolveModuleNames` wrapper, which
 * delegates strictly to standard `ts.resolveModuleName`. Any other `resolveModuleNames` or
 * `resolveModuleNameLiterals` hook is treated as a custom resolver and causes CEM import gating to
 * fail closed rather than risk disagreeing with or mutating the custom host's resolution behavior.
 */
export const NG_STANDARD_MODULE_RESOLVER: unique symbol = Symbol('NG_STANDARD_MODULE_RESOLVER');

export type StandardResolveModuleNames = NonNullable<ts.CompilerHost['resolveModuleNames']> & {
  [NG_STANDARD_MODULE_RESOLVER]?: true;
};

export type CemImportReachabilityHost = Pick<ts.CompilerHost, 'getCanonicalFileName'> &
  Partial<ts.ModuleResolutionHost> &
  Partial<Pick<ts.CompilerHost, 'resolveModuleNames' | 'resolveModuleNameLiterals'>>;

export type CemImportReachability = 'reachable' | 'gated' | 'unresolved';

/**
 * Resolves `specifier` from `emittingFile` without mutating any watch/tsserver host resolution
 * cache and classifies its reachability in `program`:
 * - `'reachable'`: resolves to a declaration already included in `program` via a non-shim chain.
 * - `'gated'`: resolves to a TypeScript/declaration file on disk that is not in `program` via
 *   non-shim files, or could not be verified because the host supplies a custom
 *   `resolveModuleNameLiterals` / untagged `resolveModuleNames` hook or lacks filesystem hooks.
 * - `'unresolved'`: does not resolve to any TypeScript declaration (e.g. a JS-only package with no
 *   `.d.ts` files when `!allowJs`), so the manifest itself remains the full type contract.
 */
export function getCemImportReachabilityInProgram(
  program: ts.Program,
  compilerHost: CemImportReachabilityHost,
  emittingFile: string,
  specifier: string,
  isShimFile: (file: ts.SourceFile) => boolean,
  getResolutionCache: () => ts.ModuleResolutionCache,
  nonShimCache?: Map<ts.Path, boolean>,
): CemImportReachability {
  if (compilerHost.resolveModuleNameLiterals !== undefined) {
    return 'gated';
  }
  const isTaggedStandardResolver =
    compilerHost.resolveModuleNames !== undefined &&
    Boolean(
      (compilerHost.resolveModuleNames as StandardResolveModuleNames)[NG_STANDARD_MODULE_RESOLVER],
    );
  if (compilerHost.resolveModuleNames !== undefined && !isTaggedStandardResolver) {
    return 'gated';
  }
  if (compilerHost.fileExists === undefined || compilerHost.readFile === undefined) {
    return 'gated';
  }
  const compilerOptions = program.getCompilerOptions();
  const host = compilerHost as ts.ModuleResolutionHost;
  // `NgCompilerHost`'s default cached `resolveModuleNames` calls `ts.resolveModuleName` without
  // an explicit `resolutionMode`; mirror that exact call when that resolver is active, and use
  // `getImpliedNodeFormatForFile` when TypeScript's built-in resolver is active (no custom hooks).
  const resolutionMode = isTaggedStandardResolver
    ? undefined
    : ts.getImpliedNodeFormatForFile(
        compilerHost.getCanonicalFileName(emittingFile) as ts.Path,
        undefined,
        host,
        compilerOptions,
      );
  const resolvedModule = ts.resolveModuleName(
    specifier,
    emittingFile,
    compilerOptions,
    host,
    getResolutionCache(),
    undefined,
    resolutionMode,
  ).resolvedModule;
  if (resolvedModule === undefined) {
    return 'unresolved';
  }
  const isJsExtension =
    resolvedModule.extension === ts.Extension.Js ||
    resolvedModule.extension === ts.Extension.Jsx ||
    resolvedModule.extension === ts.Extension.Mjs ||
    resolvedModule.extension === ts.Extension.Cjs;
  if (
    isJsExtension &&
    (!compilerOptions.allowJs ||
      (resolvedModule.isExternalLibraryImport && (compilerOptions.maxNodeModuleJsDepth ?? 0) === 0))
  ) {
    return 'unresolved';
  }
  const sf = program.getSourceFile(resolvedModule.resolvedFileName);
  if (sf === undefined) {
    return 'gated';
  }
  return isFileIncludedByNonShim(
    program,
    sf,
    isShimFile,
    (fileName) => compilerHost.getCanonicalFileName(fileName),
    nonShimCache,
  )
    ? 'reachable'
    : 'gated';
}

/**
 * Convenience predicate returning whether `specifier` from `emittingFile` is `'reachable'` in
 * `program` via a non-shim dependency chain.
 */
export function isCemImportReachableInProgram(
  program: ts.Program,
  compilerHost: CemImportReachabilityHost,
  emittingFile: string,
  specifier: string,
  isShimFile: (file: ts.SourceFile) => boolean,
  getResolutionCache: () => ts.ModuleResolutionCache,
  nonShimCache?: Map<ts.Path, boolean>,
): boolean {
  return (
    getCemImportReachabilityInProgram(
      program,
      compilerHost,
      emittingFile,
      specifier,
      isShimFile,
      getResolutionCache,
      nonShimCache,
    ) === 'reachable'
  );
}
