/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

/** A candidate JavaScript module export for a custom element class. */
export interface CustomElementImportCandidate {
  /** Module specifier to pass to TypeScript `import(...)`. */
  readonly specifier: string;
  /** Exported identifier name, or `'default'`. */
  readonly exportName: string;
}

/**
 * Structured representation of a canonical TypeScript type expression parsed from a Custom
 * Elements Manifest. Plain strings represent types without module `import(...)` or guarded
 * `CustomEvent` detail wrappers; structured nodes allow the TCB emitter to gate candidate imports
 * against the active TypeScript program without reparsing TypeScript text.
 */
export type CustomElementTypeExpr =
  | string
  | {
      readonly kind: 'import';
      readonly candidates: readonly CustomElementImportCandidate[];
      readonly typeArgs?: readonly CustomElementTypeExpr[];
    }
  | {
      readonly kind: 'customEventDetail';
      readonly inner: CustomElementTypeExpr;
    }
  | {
      readonly kind: 'concat';
      readonly parts: readonly CustomElementTypeExpr[];
    };

/** Shared structured metadata for a canonical TypeScript type expression parsed from a CEM. */
export interface CustomElementCheckTypeMetadata {
  /** Canonical TypeScript type expression parsed from the manifest's closed type grammar. */
  readonly checkType?: CustomElementTypeExpr;
  /** True when `checkType` contains an `import(...)` or `globalThis.*` type reference. */
  readonly checkTypeIsExternal?: boolean;
  /**
   * True when `checkType` resolved an unreferenced allowlisted DOM/stdlib global name (such as
   * `Selection` or `Animation`). When a class source is available, template type checking prefers
   * the class property type first to avoid shadowing a library's own type with a DOM global.
   */
  readonly checkTypeUsesUnreferencedGlobal?: boolean;
}

/** A writable property of a custom element declared in a Custom Elements Manifest. */
export interface CustomElementPropertySchema extends CustomElementCheckTypeMetadata {
  readonly name: string;
  readonly description?: string;
  readonly deprecated?: true | string;
  readonly default?: string;
}

/** An HTML attribute of a custom element declared in a Custom Elements Manifest. */
export interface CustomElementAttributeSchema extends CustomElementCheckTypeMetadata {
  readonly name: string;
  /** True when `checkType` is already a pure union of string literals with no external references. */
  readonly checkTypeIsLiteralUnion?: boolean;
  /**
   * Linked property name on the element class, used to infer static string-literal attribute
   * values from the element class when the manifest attribute has no usable type.
   */
  readonly property?: string;
  readonly description?: string;
  readonly deprecated?: true | string;
  readonly default?: string;
}

/** A custom event declared in a Custom Elements Manifest. */
export interface CustomElementEventSchema extends CustomElementCheckTypeMetadata {
  readonly name: string;
  readonly description?: string;
  readonly deprecated?: true | string;
}

/** Schema of one custom element extracted from a Custom Elements Manifest. */
export interface CustomElementsManifestSchema {
  readonly tagName: string;
  readonly properties: readonly CustomElementPropertySchema[];
  readonly attributes: readonly CustomElementAttributeSchema[];
  readonly events: readonly CustomElementEventSchema[];
  /**
   * Properties declared in the manifest as readonly, private, protected, static, or with invalid
   * modifiers. Binding to these is rejected by the schema checker even when the element has a class.
   */
  readonly unbindableProperties?: readonly string[];
  /**
   * Candidate `import()` locations for the custom element class, ordered by preference (e.g.
   * primary package path followed by manifest-directory-relative path such as `dist/...`).
   */
  readonly classImports?: readonly CustomElementImportCandidate[];
  /** Whether this schema came from a package manifest rather than a local file path. */
  readonly isPackageManifest?: boolean;
  readonly description?: string;
  readonly deprecated?: true | string;
}

interface IndexedCustomElement {
  readonly schema: CustomElementsManifestSchema;
  readonly properties: ReadonlyMap<string, CustomElementPropertySchema>;
  readonly attributes: ReadonlyMap<string, CustomElementAttributeSchema>;
  readonly events: ReadonlyMap<string, CustomElementEventSchema>;
  readonly unbindableProperties: ReadonlySet<string>;
}

/** Indexed lookup over all loaded Custom Elements Manifest schemas. */
export class CustomElementsManifestIndex {
  readonly schemas: readonly CustomElementsManifestSchema[];
  readonly tagNames: ReadonlySet<string>;

  private readonly byTag = new Map<string, IndexedCustomElement>();
  private readonly allEvents = new Set<string>();

  constructor(schemas: readonly CustomElementsManifestSchema[]) {
    this.schemas = schemas;
    const tagNames = new Set<string>();
    for (const schema of schemas) {
      const tag = schema.tagName.toLowerCase();
      if (this.byTag.has(tag)) {
        continue;
      }
      tagNames.add(tag);
      const properties = new Map<string, CustomElementPropertySchema>();
      for (const prop of schema.properties) {
        properties.set(prop.name, prop);
      }
      const attributes = new Map<string, CustomElementAttributeSchema>();
      for (const attr of schema.attributes) {
        attributes.set(attr.name, attr);
      }
      const events = new Map<string, CustomElementEventSchema>();
      for (const event of schema.events) {
        events.set(event.name, event);
        this.allEvents.add(event.name);
      }
      const unbindableProperties = new Set<string>(schema.unbindableProperties ?? []);
      this.byTag.set(tag, {schema, properties, attributes, events, unbindableProperties});
    }
    this.tagNames = tagNames;
  }

  getSchema(tagName: string): CustomElementsManifestSchema | null {
    return this.byTag.get(tagName.toLowerCase())?.schema ?? null;
  }

  hasProperty(tagName: string, propName: string): boolean {
    return this.byTag.get(tagName.toLowerCase())?.properties.has(propName) ?? false;
  }

  isUnbindableProperty(tagName: string, propName: string): boolean {
    return this.byTag.get(tagName.toLowerCase())?.unbindableProperties.has(propName) ?? false;
  }

  /** Whether the manifest supplies candidate class imports for `tagName`. */
  hasClassSource(tagName: string): boolean {
    const entry = this.byTag.get(tagName.toLowerCase());
    return entry !== undefined && (entry.schema.classImports?.length ?? 0) > 0;
  }

  getProperty(tagName: string, propName: string): CustomElementPropertySchema | null {
    return this.byTag.get(tagName.toLowerCase())?.properties.get(propName) ?? null;
  }

  getAttribute(tagName: string, attrName: string): CustomElementAttributeSchema | null {
    return this.byTag.get(tagName.toLowerCase())?.attributes.get(attrName) ?? null;
  }

  getEvent(tagName: string, eventName: string): CustomElementEventSchema | null {
    return this.byTag.get(tagName.toLowerCase())?.events.get(eventName) ?? null;
  }

  hasEventOnAnyElement(eventName: string): boolean {
    return this.allEvents.has(eventName);
  }
}
