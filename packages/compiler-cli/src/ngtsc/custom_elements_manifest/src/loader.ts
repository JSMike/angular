/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  ɵCustomElementsManifestIndex as CustomElementsManifestIndex,
  ɵCustomElementsManifestSchema as CustomElementsManifestSchema,
} from '@angular/compiler';
import ts from 'typescript';
import {CustomElementsManifestCache, NgCompilerAdapter} from '../../core/api';
import {ErrorCode, makeConfigDiagnostic} from '../../diagnostics';
import {AbsoluteFsPath} from '../../file_system';
import {ManifestResolver} from './manifest_resolver';
import {ParsedCustomElementsManifest, parseCustomElementsManifest} from './manifest_parser';
import {ManifestTypeChecker, ManifestTypeInput} from './type_resolver';
import {
  CustomElementsManifestsDiagnosticsMode,
  declarationWarningDiagnostics,
  duplicateTagDiagnostics,
} from './manifest_diagnostics';

export interface CustomElementsManifestLoadResult {
  index: CustomElementsManifestIndex | null;
  diagnostics: ts.Diagnostic[];
  /** Resource paths whose changes require a new manifest load and template checks. */
  resolutionPaths: Set<AbsoluteFsPath>;
}

/**
 * One load has three boundaries: the resolver owns host reads and dependencies, the parser
 * projects JSON without filesystem access, and the type checker produces validated schemas.
 * The compiler and editor consume only the resulting index. Cache reuse requires the same
 * options, ambient program, and observed file contents; recovery never removes unrelated tags.
 */
export function loadCustomElementsManifests(
  entries: readonly string[],
  basePath: AbsoluteFsPath,
  options: ts.CompilerOptions,
  adapter: NgCompilerAdapter,
  program: ts.Program,
  diagnosticsMode: CustomElementsManifestsDiagnosticsMode = 'summary',
  cache: CustomElementsManifestCache | null = null,
): CustomElementsManifestLoadResult {
  const sources = new ManifestResolver(basePath, options, adapter);
  const checker = new ManifestTypeChecker(sources, program);
  if (!sources.canCache) {
    cache = null;
  }
  // CompilerOptions contains one non-JSON field, the parsed configuration SourceFile. Its path
  // affects relative resolution; the actual option values are already present on this object.
  const {configFile, ...compilerOptions} = options;
  const key = JSON.stringify([
    entries,
    basePath,
    diagnosticsMode,
    compilerOptions,
    typeof configFile === 'object' && configFile !== null && 'fileName' in configFile
      ? configFile.fileName
      : configFile,
    checker.programTypeEnvironment,
  ]);
  const cached = readValidCacheEntry(cache, key, sources, checker);
  if (cached !== null) {
    return cached;
  }

  const diagnostics: ts.Diagnostic[][] = [];
  const manifests: Array<{
    input: ManifestTypeInput;
    parsed: ParsedCustomElementsManifest;
    diagnostics: ts.Diagnostic[];
  }> = [];
  for (const entry of entries) {
    const messages: ts.Diagnostic[] = [];
    diagnostics.push(messages);
    const resolution = sources.resolveManifest(entry);
    if (resolution.kind === 'failure') {
      messages.push(
        makeConfigDiagnostic(
          ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND,
          `Angular compiler option "customElementsManifests" contains an entry '${entry}' that could not ` +
            `be resolved to a Custom Elements Manifest file: ${resolution.reason}`,
        ),
      );
      continue;
    }
    const label =
      entry === resolution.path ? `'${resolution.path}'` : `'${entry}' ('${resolution.path}')`;
    const content = sources.readManifest(resolution.path);
    if (content === null) {
      messages.push(
        makeConfigDiagnostic(
          ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND,
          `Angular compiler option "customElementsManifests": the Custom Elements Manifest ${label} could not be read.`,
        ),
      );
      continue;
    }
    const parsed = parseCustomElementsManifest(content, label, resolution.packageName);
    messages.push(
      ...parsed.errors.map((error) =>
        makeConfigDiagnostic(ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_INVALID, error),
      ),
    );
    manifests.push({
      input: {
        path: resolution.path,
        packageName: resolution.packageName,
        label,
        schemas: parsed.schemas,
      },
      parsed,
      diagnostics: messages,
    });
  }

  const resolved = checker.resolve(
    manifests.map(({input}) => input),
    diagnosticsMode,
  );
  const byTag = new Map<string, {schema: CustomElementsManifestSchema; label: string}>();
  for (const [index, manifest] of manifests.entries()) {
    const {
      input: {label},
      parsed,
      diagnostics: messages,
    } = manifest;
    messages.push(
      ...resolved[index].diagnostics,
      ...declarationWarningDiagnostics(
        label,
        [...parsed.warnings, ...resolved[index].warnings],
        diagnosticsMode,
      ),
    );
    const duplicates: Array<{tagName: string; winnerManifestLabel: string}> = [];
    for (const schema of resolved[index].schemas) {
      const winner = byTag.get(schema.tagName);
      if (winner === undefined) {
        byTag.set(schema.tagName, {schema, label});
      } else {
        duplicates.push({tagName: schema.tagName, winnerManifestLabel: winner.label});
      }
    }
    messages.push(...duplicateTagDiagnostics(label, duplicates, diagnosticsMode));
  }
  const result: CustomElementsManifestLoadResult = {
    index:
      byTag.size === 0
        ? null
        : new CustomElementsManifestIndex(Array.from(byTag.values(), ({schema}) => schema)),
    diagnostics: diagnostics.flat(),
    resolutionPaths: sources.resolutionPaths,
  };
  if (cache !== null) {
    cache.entry = sources.hasConsistentReads
      ? ({
          key,
          environment: new Map(checker.environmentFiles.map((file) => [file.fileName, file.text])),
          files: sources.files,
          result,
        } satisfies ManifestCacheEntry)
      : null;
  }
  return result;
}

/** A snapshot of the inputs actually used by one successful or recoverable load. */
interface ManifestCacheEntry {
  key: string;
  environment: Map<string, string>;
  files: ManifestResolver['files'];
  result: CustomElementsManifestLoadResult;
}

function readValidCacheEntry(
  cache: CustomElementsManifestCache | null,
  key: string,
  sources: ManifestResolver,
  checker: ManifestTypeChecker,
): CustomElementsManifestLoadResult | null {
  const environment = checker.environmentFiles;
  const entry = cache?.entry as ManifestCacheEntry | null | undefined;
  if (entry == null || entry.key !== key || entry.environment.size !== environment.length) {
    return null;
  }
  for (const file of environment) {
    if (entry.environment.get(file.fileName) !== file.text) {
      return null;
    }
  }
  if (!sources.matches(entry.files, checker.program)) {
    return null;
  }
  for (const path of entry.result.resolutionPaths) {
    sources.adapter.recordResourceDependency?.(path);
  }
  return entry.result;
}
