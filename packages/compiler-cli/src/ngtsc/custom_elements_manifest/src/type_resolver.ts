/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {ɵCustomElementsManifestSchema as CustomElementsManifestSchema} from '@angular/compiler';
import ts from 'typescript';
import {NgCompilerAdapter} from '../../core/api';
import {AbsoluteFsPath, dirname, join, relative} from '../../file_system';
import {CheckTypeImport} from './check_type';
import {
  CustomElementsManifestsDiagnosticsMode,
  ProgramTypeEnvironment,
  typeReferenceDiagnostics,
} from './manifest_diagnostics';
import {ManifestResolver} from './manifest_resolver';
import {ManifestCheckType, ManifestWarning, ParsedCustomElementSchema} from './schema';

export interface ManifestTypeInput {
  path: AbsoluteFsPath;
  label: string;
  packageName: string | null;
  schemas: readonly ParsedCustomElementSchema[];
}

export interface ManifestTypeResult {
  schemas: CustomElementsManifestSchema[];
  warnings: ManifestWarning[];
  diagnostics: ts.Diagnostic[];
}

/** One semantic result is shared by all occurrences of the same resolved type text. */
interface CheckedType {
  text: string;
  errors: readonly ts.Diagnostic[];
  stringLiteralValues: string[] | null;
}

interface ManifestTypes {
  input: ManifestTypeInput;
  occurrences: Map<ManifestCheckType, CheckedType>;
  instanceTypes: Set<ManifestCheckType>;
  modules: Map<string, string>;
  imports: Map<string, Set<string>>;
  globals: Set<string>;
  missingModules: Set<string>;
}

const TYPESCRIPT_FILE = /\.(?:d\.)?[cm]?tsx?$/;
const TYPESCRIPT_SPECIFIER = /\.[mc]?tsx?$/;

/**
 * Resolve references, check unique type expressions once, then project the public schemas.
 * This is the only semantic-validation entry point. Parsed schemas are never mutated, and
 * shared results retain separate origins and recovery decisions for every member occurrence.
 */
export class ManifestTypeChecker {
  readonly environmentFiles: readonly ts.SourceFile[];
  readonly programTypeEnvironment: ProgramTypeEnvironment;

  constructor(
    readonly sources: ManifestResolver,
    readonly program: ts.Program,
  ) {
    this.environmentFiles = getTypeEnvironmentFiles(program, sources.adapter);
    this.programTypeEnvironment = {
      hasDefaultLibrary: program
        .getSourceFiles()
        .some((file) => program.isSourceFileDefaultLibrary(file)),
      isSolutionStyleRoot:
        program.getRootFileNames().length === 0 &&
        (program.getProjectReferences()?.length ?? 0) > 0,
    };
  }

  resolve(
    manifests: readonly ManifestTypeInput[],
    mode: CustomElementsManifestsDiagnosticsMode,
  ): ManifestTypeResult[] {
    const types = new Map<string, CheckedType>();
    const prepared = manifests.map((input) => collectTypes(input, this, types));
    const roots = new Set(prepared.flatMap(({modules}) => [...modules.values()]));
    if (prepared.some(({imports, globals}) => imports.size > 0 || globals.size > 0)) {
      for (const file of this.environmentFiles) {
        roots.add(file.fileName);
      }
    }
    const program = types.size === 0 ? null : checkTypes([...types.values()], [...roots], this);
    return prepared.map((manifest) => projectSchemas(manifest, program, this, mode));
  }
}

/** Register each occurrence against a type key after resolving its manifest-relative imports. */
function collectTypes(
  input: ManifestTypeInput,
  load: ManifestTypeChecker,
  types: Map<string, CheckedType>,
): ManifestTypes {
  const analyses = new Set<ManifestCheckType>();
  const instanceTypes = new Set<ManifestCheckType>();
  const imports = new Map<string, Set<string>>();
  const globals = new Set<string>();
  for (const schema of input.schemas) {
    for (const member of [...schema.properties, ...schema.attributes, ...schema.events]) {
      if (member.checkType !== undefined) {
        analyses.add(member.checkType);
      }
    }
    if (schema.instanceCheckType !== undefined) {
      analyses.add(schema.instanceCheckType);
      instanceTypes.add(schema.instanceCheckType);
    }
  }
  for (const analysis of analyses) {
    for (const {specifier, name} of analysis.imports) {
      if (!imports.has(specifier)) {
        imports.set(specifier, new Set());
      }
      imports.get(specifier)!.add(name);
    }
    for (const name of analysis.globals) {
      globals.add(name);
    }
  }

  const modules = new Map<string, string>();
  const replacements = new Map<string, string>();
  const missingModules = new Set<string>();
  const containingFile = join(load.sources.basePath, 'index.ts');
  for (const specifier of imports.keys()) {
    // Source .ts specifiers are not an importable declaration contract for a published package.
    if (TYPESCRIPT_SPECIFIER.test(specifier)) {
      missingModules.add(specifier);
      continue;
    }
    let resolved = load.sources.resolveModule(specifier, containingFile);
    if (resolved === undefined) {
      const relative = manifestRelativeModuleSpecifier(
        specifier,
        input.path,
        input.packageName,
        load,
      );
      if (relative !== null) {
        resolved = load.sources.resolveModule(relative, containingFile);
        if (resolved !== undefined) {
          replacements.set(specifier, relative);
        }
      }
    }
    if (resolved === undefined || !TYPESCRIPT_FILE.test(resolved.resolvedFileName)) {
      missingModules.add(specifier);
    } else {
      modules.set(specifier, resolved.resolvedFileName);
    }
  }

  const occurrences = new Map<ManifestCheckType, CheckedType>();
  for (const analysis of analyses) {
    const text = rewriteImportSpecifiers(analysis.checkType, analysis.imports, replacements);
    if (!types.has(text)) {
      types.set(text, {text, errors: [], stringLiteralValues: null});
    }
    occurrences.set(analysis, types.get(text)!);
  }
  return {input, occurrences, instanceTypes, modules, imports, globals, missingModules};
}

function checkTypes(types: CheckedType[], roots: string[], load: ManifestTypeChecker): ts.Program {
  const source = ts.createSourceFile(
    join(load.sources.basePath, '__ng_custom_elements_manifest_types__.ts'),
    types.map(({text}, index) => `export type __CemType${index} = (${text});`).join('\n'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const program = createTypeCheckingProgram(source, roots, load);
  const diagnostics = program.getSemanticDiagnostics(source);
  const checker = program.getTypeChecker();
  for (const [index, statement] of source.statements.entries()) {
    if (!ts.isTypeAliasDeclaration(statement)) {
      throw new Error('Unexpected declaration in the manifest type-checking source.');
    }
    types[index].errors = diagnostics.filter(
      ({start}) => start !== undefined && start >= statement.pos && start < statement.end,
    );
    types[index].stringLiteralValues = resolvedStringLiteralValues(
      checker.getTypeFromTypeNode(statement.type),
    );
  }
  return program;
}

/** Decide recovery per occurrence before exposing any type text to template generation. */
function projectSchemas(
  {input, occurrences, instanceTypes, modules, imports, globals, missingModules}: ManifestTypes,
  program: ts.Program | null,
  load: ManifestTypeChecker,
  mode: CustomElementsManifestsDiagnosticsMode,
): ManifestTypeResult {
  const missingExports =
    program === null
      ? new Map<string, Set<string>>()
      : findMissingExports(program, modules, imports);
  const missingGlobals = new Set<string>();
  for (const name of globals) {
    const available =
      load.program.getTypeChecker().resolveName(name, undefined, ts.SymbolFlags.Type, false) !==
      undefined;
    if (!available) {
      missingGlobals.add(name);
    }
  }
  const warnings: ManifestWarning[] = [];
  const genericInstanceTypes = new Set<string>();
  const usable = new Map<ManifestCheckType, CheckedType>();
  for (const [analysis, checked] of occurrences) {
    if (
      analysis.imports.some(
        ({specifier, name}) =>
          missingModules.has(specifier) || missingExports.get(specifier)?.has(name),
      ) ||
      analysis.globals.some((name) => missingGlobals.has(name))
    ) {
      continue;
    }
    if (checked.errors.length === 0) {
      usable.set(analysis, checked);
    } else if (
      instanceTypes.has(analysis) &&
      // TypeScript diagnostics for a generic with omitted required type arguments.
      checked.errors.some(({code}) => code === 2314 || code === 2707)
    ) {
      genericInstanceTypes.add(analysis.checkType);
    } else {
      warnings.push({
        kind: 'unusableType',
        subject: analysis.subject,
        message:
          `The Custom Elements Manifest ${input.label} declares type text ` +
          `${JSON.stringify(analysis.originalText)} for ${analysis.subject} that TypeScript cannot use: ` +
          checked.errors
            .map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' '))
            .join(' ') +
          ` Affected checks use a safe fallback; other checks are unaffected.`,
      });
    }
  }
  function projectMember<T extends {checkType?: ManifestCheckType}>(
    member: T,
  ): Omit<T, 'checkType'> & {checkType?: string} {
    const {checkType, ...metadata} = member;
    const result = checkType === undefined ? undefined : usable.get(checkType);
    return {...metadata, ...(result === undefined ? {} : {checkType: result.text})};
  }
  return {
    schemas: input.schemas.map(
      ({properties, attributes, events, instanceCheckType, ...metadata}) => {
        const instance =
          instanceCheckType === undefined ? undefined : usable.get(instanceCheckType);
        return {
          ...metadata,
          properties: properties.map(projectMember),
          events: events.map(projectMember),
          attributes: attributes.map((attribute) => {
            const values =
              attribute.checkType === undefined
                ? undefined
                : usable.get(attribute.checkType)?.stringLiteralValues;
            return {
              ...projectMember(attribute),
              ...(values?.length ? {stringLiteralValues: values} : {}),
            };
          }),
          ...(instance === undefined ? {} : {instanceCheckType: instance.text}),
        };
      },
    ),
    warnings,
    diagnostics: typeReferenceDiagnostics(
      input.label,
      mode,
      load.programTypeEnvironment,
      missingModules,
      missingExports,
      missingGlobals,
      genericInstanceTypes,
    ),
  };
}

/** Builds a checking program that reuses consumer sources and records additional dependencies. */
function createTypeCheckingProgram(
  source: ts.SourceFile,
  rootNames: readonly string[],
  {sources, program: inputProgram}: ManifestTypeChecker,
): ts.Program {
  const {adapter, options, typeModuleResolutionCache} = sources;
  const fileName = source.fileName;
  // Library and ambient files are explicit roots from the consuming program.
  const programOptions: ts.CompilerOptions = {
    ...options,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
  };
  const host: ts.CompilerHost = {
    fileExists: (path) => path === fileName || sources.fileExists(path),
    readFile: (path) => (path === fileName ? source.text : sources.readFile(path)),
    getSourceFile: (path, languageVersion) =>
      path === fileName ? source : sources.getSourceFile(path, languageVersion, inputProgram),
    getDefaultLibFileName: () => 'lib.d.ts',
    getModuleResolutionCache: () => typeModuleResolutionCache,
    writeFile: () => undefined,
    getCurrentDirectory: adapter.getCurrentDirectory.bind(adapter),
    getCanonicalFileName: adapter.getCanonicalFileName.bind(adapter),
    useCaseSensitiveFileNames: () =>
      typeof adapter.useCaseSensitiveFileNames === 'function'
        ? adapter.useCaseSensitiveFileNames()
        : (adapter.useCaseSensitiveFileNames ?? true),
    getNewLine: () => '\n',
    directoryExists:
      adapter.directoryExists === undefined ? undefined : sources.directoryExists.bind(sources),
    getDirectories: adapter.getDirectories?.bind(adapter),
    realpath: adapter.realpath === undefined ? undefined : sources.realpath.bind(sources),
  };
  if (!sources.canCache) {
    host.resolveModuleNames = (names, containingFile) =>
      names.map((name) => sources.resolveModule(name, containingFile));
  } else {
    host.resolveModuleNameLiterals = (
      literals,
      containingFile,
      _redirectedReference,
      compilerOptions,
      containingSourceFile,
    ) =>
      literals.map((literal) => ({
        // The built-in resolver returns the full module shape. Custom resolvers use the hook above.
        resolvedModule: sources.resolveModule(
          literal.text,
          containingFile,
          ts.getModeForUsageLocation(containingSourceFile, literal, compilerOptions),
        ) as ts.ResolvedModuleFull | undefined,
      }));
  }
  source.impliedNodeFormat = ts.getImpliedNodeFormatForFile(
    fileName,
    typeModuleResolutionCache,
    host,
    options,
  );
  return ts.createProgram({rootNames: [fileName, ...rootNames], options: programOptions, host});
}

/** Confirms exact exported type names, including re-exports. */
function findMissingExports(
  program: ts.Program,
  resolvedFiles: ReadonlyMap<string, string>,
  referencedNames: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const missingExports = new Map<string, Set<string>>();
  const checker = program.getTypeChecker();
  for (const [specifier, resolvedFile] of resolvedFiles) {
    const file = program.getSourceFile(resolvedFile);
    const moduleSymbol = file === undefined ? undefined : checker.getSymbolAtLocation(file);
    const exports = new Map(
      moduleSymbol === undefined
        ? []
        : checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]),
    );
    for (const name of referencedNames.get(specifier) ?? []) {
      const exported = exports.get(name);
      const target =
        exported !== undefined && (exported.flags & ts.SymbolFlags.Alias) !== 0
          ? checker.getAliasedSymbol(exported)
          : exported;
      if (target === undefined || (target.flags & ts.SymbolFlags.Type) === 0) {
        let names = missingExports.get(specifier);
        if (names === undefined) {
          names = new Set();
          missingExports.set(specifier, names);
        }
        names.add(name);
      }
    }
  }
  return missingExports;
}

/** Rewrite only validated import specifier spans, leaving literal type contents unchanged. */
function rewriteImportSpecifiers(
  text: string,
  imports: readonly CheckTypeImport[],
  replacements: ReadonlyMap<string, string>,
): string {
  for (const reference of [...imports].sort((a, b) => b.start - a.start)) {
    const replacement = replacements.get(reference.specifier);
    if (replacement !== undefined) {
      text = text.slice(0, reference.start) + replacement + text.slice(reference.end);
    }
  }
  return text;
}

function resolvedStringLiteralValues(type: ts.Type): string[] | null {
  if (type.isUnion()) {
    const values: string[] = [];
    for (const member of type.types) {
      const memberValues = resolvedStringLiteralValues(member);
      if (memberValues === null) {
        return null;
      }
      values.push(...memberValues);
    }
    return Array.from(new Set(values));
  }
  if (
    (type.flags &
      (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never | ts.TypeFlags.Void)) !==
    0
  ) {
    return [];
  }
  return type.isStringLiteral() ? [type.value] : null;
}

/**
 * Resolves module paths relative to the manifest directory after resolution from the package
 * root has failed.
 */
function manifestRelativeModuleSpecifier(
  specifier: string,
  manifestPath: AbsoluteFsPath,
  packageName: string | null,
  {sources}: ManifestTypeChecker,
): string | null {
  if (
    packageName === null ||
    (specifier !== packageName && !specifier.startsWith(`${packageName}/`))
  ) {
    return null;
  }
  const packageJsonPath = sources.findOwningPackageJson(dirname(manifestPath), packageName);
  if (packageJsonPath === null) {
    return null;
  }
  const manifestDirectory = relative(dirname(packageJsonPath), dirname(manifestPath));
  if (manifestDirectory.length === 0) {
    return null;
  }
  return `${packageName}/${manifestDirectory}${specifier.slice(packageName.length)}`;
}

/** Selects ambient declarations without pulling unrelated application modules into validation. */
function getTypeEnvironmentFiles(program: ts.Program, adapter: NgCompilerAdapter): ts.SourceFile[] {
  return program
    .getSourceFiles()
    .filter(
      (file) =>
        !adapter.isShim(file) &&
        !adapter.isResource(file) &&
        (file.flags & ts.NodeFlags.JsonFile) === 0 &&
        (!ts.isExternalModule(file) ||
          file.statements.some(
            (statement) =>
              ts.isModuleDeclaration(statement) &&
              ((statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0 ||
                ts.isStringLiteral(statement.name)),
          )),
    );
}
