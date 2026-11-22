/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {SchemaMetadata} from '../../core';
import {BoundTarget} from '../../render3/view/t2_api';
import {CustomElementTypeExpr} from '../../schema/custom_elements_manifest_schema';
import {TypeCheckId, TcbDirectiveMetadata, TcbPipeMetadata, TcbEnvironment} from '../api';
import {OutOfBandDiagnosticRecorder} from '../oob';
import {DomSchemaChecker} from '../schema';
import {TcbExpr} from './codegen';
import {
  buildCustomElementRawTypeExpr,
  CEM_TCB_HELPERS,
  CemHelperName,
  renderCustomElementTypeExpr,
} from './custom_elements';

/**
 * Controls how generics for the component context class will be handled during TCB generation.
 */
export enum TcbGenericContextBehavior {
  /**
   * References to generic parameter bounds will be emitted via the `TypeParameterEmitter`.
   *
   * The caller must verify that all parameter bounds are emittable in order to use this mode.
   */
  UseEmitter,

  /**
   * Generic parameter declarations will be copied directly from the `ts.ClassDeclaration` of the
   * component class.
   *
   * The caller must only use the generated TCB code in a context where such copies will still be
   * valid, such as an inline type check block.
   */
  CopyClassNodes,

  /**
   * Any generic parameters for the component context class will be set to `any`.
   *
   * Produces a less useful type, but is always safe to use.
   */
  FallbackToAny,
}

/**
 * Overall generation context for the type check block.
 *
 * `Context` handles operations during code generation which are global with respect to the whole
 * block. It's responsible for variable name allocation and management of any imports needed. It
 * also contains the template metadata itself.
 */
export class Context {
  private nextId = 1;
  private nextCemAliasId = 1;
  private usedCemHelpers = new Set<CemHelperName>();
  private cemHelperStatements: TcbExpr[] = [];
  private cemAliasStatements: TcbExpr[] = [];
  private cemRawTypeAliases = new Map<
    string,
    {readonly alias: string; readonly hasGatedClassImport: boolean}
  >();
  private cemTypeAliases = new Map<string, string>();

  constructor(
    readonly env: TcbEnvironment,
    readonly domSchemaChecker: DomSchemaChecker<unknown>,
    readonly oobRecorder: OutOfBandDiagnosticRecorder<unknown>,
    readonly id: TypeCheckId,
    readonly boundTarget: BoundTarget<TcbDirectiveMetadata>,
    private pipes: Map<string, TcbPipeMetadata> | null,
    readonly schemas: SchemaMetadata[],
    readonly hostIsStandalone: boolean,
    readonly hostPreserveWhitespaces: boolean,
  ) {}

  /**
   * Allocate a new variable name for use within the `Context`.
   *
   * Currently this uses a monotonically increasing counter, but in the future the variable name
   * might change depending on the type of data being stored.
   */
  allocateId(): string {
    return `_t${this.nextId++}`;
  }

  getPipeByName(name: string): TcbPipeMetadata | null {
    if (this.pipes === null || !this.pipes.has(name)) {
      return null;
    }
    return this.pipes.get(name)!;
  }

  /** Queues a specific `_Cem*` helper type alias (and its dependencies) once in this file or TCB. */
  useCemHelper(name: CemHelperName): void {
    if (this.usedCemHelpers.has(name)) {
      return;
    }
    const helper = CEM_TCB_HELPERS[name];
    if (helper.deps !== undefined) {
      for (const dep of helper.deps) {
        this.useCemHelper(dep);
      }
    }
    this.usedCemHelpers.add(name);
    if (this.env.hoistCemHelper !== undefined) {
      this.env.hoistCemHelper(name, helper.decl);
    } else {
      this.cemHelperStatements.push(new TcbExpr(helper.decl));
    }
  }

  /**
   * Returns the unmapped type alias name (`_CemRaw_N`) and gating status for a manifest custom
   * element's raw class type, allocating and emitting it once per tag in this file or TCB.
   */
  getCustomElementRawTypeInfo(
    tagName: string,
  ): {readonly alias: string; readonly hasGatedClassImport: boolean} | null {
    const index = this.env.config.customElementsManifestIndex ?? null;
    if (index === null) {
      return null;
    }
    const normalizedTag = tagName.toLowerCase();
    const existing = this.cemRawTypeAliases.get(normalizedTag);
    if (existing !== undefined) {
      return existing;
    }
    const schema = index.getSchema(normalizedTag);
    if (schema === null) {
      return null;
    }
    const getImportReachability = this.env.getCemImportReachability?.bind(this.env);
    const {expr: rawExpr, hasGatedClassImport} = buildCustomElementRawTypeExpr(
      normalizedTag,
      schema,
      (helper) => this.useCemHelper(helper),
      getImportReachability,
    );
    const alias =
      this.env.hoistCemAlias !== undefined
        ? this.env.hoistCemAlias(`raw:${normalizedTag}`, '_CemRaw_', rawExpr)
        : `_CemRaw_${this.nextCemAliasId++}`;
    if (this.env.hoistCemAlias === undefined) {
      this.cemAliasStatements.push(new TcbExpr(`type ${alias} = ${rawExpr}`));
    }
    const info = {alias, hasGatedClassImport};
    this.cemRawTypeAliases.set(normalizedTag, info);
    return info;
  }

  /**
   * Returns the unmapped type alias name (`_CemRaw_N`) for a manifest custom element's raw
   * class type, allocating and emitting it once per tag in this file or TCB.
   */
  getCustomElementRawTypeAlias(tagName: string): string | null {
    return this.getCustomElementRawTypeInfo(tagName)?.alias ?? null;
  }

  /**
   * Renders a manifest `CustomElementTypeExpr` (gating module `import(...)` candidates against
   * `env.canEmitCemImport` when present) and allocates (or reuses) an unmapped type alias
   * (`_CemT_N`) so unresolved `import(...)` / `globalThis.*` diagnostics are dropped by diagnostic
   * translation. Returns `null` when the rendered type collapses directly to `'unknown'`.
   */
  allocateCemTypeAlias(typeExpr: CustomElementTypeExpr): string | null {
    const getImportReachability = this.env.getCemImportReachability?.bind(this.env);
    const rendered = renderCustomElementTypeExpr(
      typeExpr,
      (helper) => this.useCemHelper(helper),
      getImportReachability,
    );
    if (rendered === 'unknown') {
      return null;
    }
    const existing = this.cemTypeAliases.get(rendered);
    if (existing !== undefined) {
      return existing;
    }
    const alias =
      this.env.hoistCemAlias !== undefined
        ? this.env.hoistCemAlias(`type:${rendered}`, '_CemT_', rendered)
        : `_CemT_${this.nextCemAliasId++}`;
    if (this.env.hoistCemAlias === undefined) {
      this.cemAliasStatements.push(new TcbExpr(`type ${alias} = ${rendered}`));
    }
    this.cemTypeAliases.set(rendered, alias);
    return alias;
  }

  /** Returns all unmapped CEM helper and alias statements queued for this TCB. */
  getCemPreludeStatements(): TcbExpr[] {
    return [...this.cemHelperStatements, ...this.cemAliasStatements];
  }
}
