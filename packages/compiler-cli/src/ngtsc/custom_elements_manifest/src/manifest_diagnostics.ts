/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';
import {ErrorCode, makeConfigDiagnostic} from '../../diagnostics';
import {ManifestWarning} from './schema';

/** Summary by default; verbose diagnostics retain every individual origin. */
export type CustomElementsManifestsDiagnosticsMode = 'summary' | 'verbose';

/** Consumer program facts used to explain unavailable global type references. */
export interface ProgramTypeEnvironment {
  hasDefaultLibrary: boolean;
  isSolutionStyleRoot: boolean;
}

/** Describes the checks disabled by an NG4011 warning. */
export function checkTypeFallbackEffect(affectsLocalReferences: boolean): string {
  return (
    `Bindings, static attributes, and events that depend on these types are not type-checked` +
    (affectsLocalReferences ? `, and affected local references fall back to HTMLElement` : ``) +
    `; other checks are unaffected.`
  );
}

/** Explains how to expand summarized warnings. */
export const VERBOSE_HINT =
  'This summary can be expanded using the `customElementsManifestsDiagnostics = "verbose"` ' +
  'compiler option.';

/** Quotes up to three example values for a summarized diagnostic. */
export function formatExamples(values: readonly string[]): string {
  return values
    .slice(0, 3)
    .map((value) => `'${value}'`)
    .join(', ');
}

/**
 * Converts per-declaration warnings, folding same-kind warnings for one manifest
 * into a single summary diagnostic unless verbose reporting was requested.
 */
export function declarationWarningDiagnostics(
  manifestLabel: string,
  warnings: readonly ManifestWarning[],
  diagnosticsMode: CustomElementsManifestsDiagnosticsMode,
): ts.Diagnostic[] {
  const groups = new Map<ManifestWarning['kind'], ManifestWarning[]>();
  for (const warning of warnings) {
    let group = groups.get(warning.kind);
    if (group === undefined) {
      group = [];
      groups.set(warning.kind, group);
    }
    group.push(warning);
  }
  return Array.from(groups).flatMap(([kind, group]) =>
    summarizeWarnings(
      group,
      warningErrorCode(kind),
      diagnosticsMode,
      (warning) => warning.message,
      () => {
        const examples = formatExamples(group.map((warning) => warning.subject));
        let message: string;
        switch (kind) {
          case 'invalidTagName':
            message =
              `${manifestLabel} declares ${group.length} custom elements whose tag names are not ` +
              `valid custom element names (e.g. ${examples}). These declarations are ignored. ` +
              VERBOSE_HINT;
            break;
          case 'duplicateTag':
            message =
              `${manifestLabel} declares ${group.length} custom element tags more than once ` +
              `(e.g. ${examples}). A tag can only be registered once, so the first declaration of ` +
              `each is used and the others are ignored. ` +
              VERBOSE_HINT;
            break;
          case 'unusableType':
            message =
              `${manifestLabel} contains ${group.length} distinct type-metadata problems Angular ` +
              `cannot safely use (e.g. ${examples}). The count describes reported metadata problems, ` +
              `not necessarily every declaration that depends on them. Affected declarations remain available, but ` +
              `template checks that depend on these types use safe fallbacks; other checks are unaffected. ` +
              VERBOSE_HINT;
            break;
          case 'invalidStructure':
            message =
              `${manifestLabel} contains ${group.length} structurally inconsistent manifest ` +
              `entries (e.g. ${examples}). Angular retains unrelated valid metadata and applies the ` +
              `narrow fallback described by each entry. ` +
              VERBOSE_HINT;
            break;
        }
        return message;
      },
    ),
  );
}

/** Applies the same bounded summary/verbose policy to every manifest warning category. */
function summarizeWarnings<T>(
  warnings: readonly T[],
  code: ErrorCode,
  mode: CustomElementsManifestsDiagnosticsMode,
  describe: (warning: T) => string,
  summarize: () => string,
): ts.Diagnostic[] {
  const messages =
    mode === 'verbose' || warnings.length <= 1 ? warnings.map(describe) : [summarize()];
  return messages.map((message) =>
    makeConfigDiagnostic(code, message, ts.DiagnosticCategory.Warning),
  );
}

export function duplicateTagDiagnostics(
  manifestLabel: string,
  duplicates: readonly {tagName: string; winnerManifestLabel: string}[],
  mode: CustomElementsManifestsDiagnosticsMode,
): ts.Diagnostic[] {
  return summarizeWarnings(
    duplicates,
    ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_DUPLICATE_TAG,
    mode,
    ({tagName, winnerManifestLabel}) =>
      `The custom element tag '${tagName}' declared in ${manifestLabel} was ` +
      `already declared by ${winnerManifestLabel}, an earlier configured entry in the ` +
      `"customElementsManifests" compiler option. A tag can only be registered once, ` +
      `so the declaration from ${winnerManifestLabel} is retained and the declaration ` +
      `from ${manifestLabel} is ignored.`,
    () =>
      `${duplicates.length} custom element tags declared in ${manifestLabel} ` +
      `(e.g. '${duplicates[0].tagName}', retained from ${duplicates[0].winnerManifestLabel}) were ` +
      `already declared by earlier configured entries in the "customElementsManifests" ` +
      `compiler option. A tag can only be registered once, so the earlier declarations ` +
      `are retained and the declarations from ${manifestLabel} are ignored. ` +
      VERBOSE_HINT,
  );
}

/** Formats semantic validation problems without making the resolver own diagnostic presentation. */
export function typeReferenceDiagnostics(
  manifestLabel: string,
  mode: CustomElementsManifestsDiagnosticsMode,
  environment: ProgramTypeEnvironment,
  unresolvableSpecifiers: Set<string>,
  missingExports: Map<string, Set<string>>,
  missingGlobals: Set<string>,
  genericInstanceTypes: Set<string>,
): ts.Diagnostic[] {
  const hint =
    missingGlobals.size === 0
      ? ''
      : environment.isSolutionStyleRoot
        ? ' The compiler is analyzing a solution-style tsconfig with no root files. Build with the ' +
          "application tsconfig (for example tsconfig.app.json, as 'ng build' does) instead."
        : !environment.hasDefaultLibrary
          ? ' No TypeScript default library files are loaded in this program. Verify that its "lib" and ' +
            '"noLib" compiler options are intentional.'
          : '';
  const prefix = `The Custom Elements Manifest ${manifestLabel}`;
  const fallback = checkTypeFallbackEffect(true);
  const problems = [
    ...Array.from(
      unresolvableSpecifiers,
      (specifier) =>
        `${prefix} references types in '${specifier}', which does not resolve to TypeScript declarations. ${fallback}`,
    ),
    ...Array.from(
      missingExports,
      ([specifier, names]) =>
        `${prefix} references ${formatQuotedList(names)} from '${specifier}', but its TypeScript declarations do not export ` +
        `${names.size === 1 ? 'a usable type with that name' : 'usable types with those names'}. ${fallback}`,
    ),
    ...(missingGlobals.size === 0
      ? []
      : [
          `${prefix} references ${formatQuotedList(missingGlobals)} from 'global:', but the consuming TypeScript program does not declare ` +
            `${missingGlobals.size === 1 ? 'a usable global type with that name' : 'usable global types with those names'}.` +
            hint +
            ' ' +
            checkTypeFallbackEffect(false),
        ]),
  ];
  const diagnostics = summarizeWarnings(
    problems,
    ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_UNRESOLVABLE_TYPE_REFERENCE,
    mode,
    (message) => message,
    () => {
      const parts: string[] = [];
      for (const [count, noun, reason] of [
        [
          unresolvableSpecifiers.size,
          'module specifier',
          'that do not resolve to TypeScript declarations',
        ],
        [missingExports.size, 'module', 'whose declarations are missing referenced types'],
        [missingGlobals.size, 'global type name', 'not declared by the consuming program'],
      ] as const) {
        if (count > 0) {
          parts.push(`${count} ${noun}${count === 1 ? '' : 's'} ${reason}`);
        }
      }
      return (
        `${prefix} has unusable type references: ${parts.join(', ')} ` +
        `(e.g. ${formatExamples([...unresolvableSpecifiers, ...missingExports.keys(), ...missingGlobals])}).` +
        `${hint} ${fallback} ${VERBOSE_HINT}`
      );
    },
  );
  if (genericInstanceTypes.size > 0) {
    diagnostics.unshift(
      makeConfigDiagnostic(
        ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_UNRESOLVABLE_TYPE_REFERENCE,
        `${prefix} references element instance types ${formatQuotedList(genericInstanceTypes)} that require type arguments. ` +
          'Affected local references fall back to HTMLElement; other checks are unaffected.',
        ts.DiagnosticCategory.Warning,
      ),
    );
  }
  return diagnostics;
}

export function formatQuotedList(values: Set<string>): string {
  return Array.from(values, (value) => `'${value}'`).join(values.size === 2 ? ' and ' : ', ');
}

function warningErrorCode(kind: ManifestWarning['kind']): ErrorCode {
  switch (kind) {
    case 'invalidTagName':
      return ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_INVALID_TAG_NAME;
    case 'duplicateTag':
      return ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_DUPLICATE_TAG;
    case 'unusableType':
      return ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_UNUSABLE_TYPE;
    case 'invalidStructure':
      return ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_INVALID_STRUCTURE;
  }
}
