/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {BindingType} from '../../expression_parser/ast';
import {
  CustomElementsManifestIndex,
  normalizeCustomElementTagName,
} from '../../schema/custom_elements_manifest_schema';
import {Element, Node, RecursiveVisitor, visitAll} from '../r3_ast';
import {DOM_PROPERTY_REMAPPING} from '../util';

/**
 * Finds property bindings in `template` to manifest properties that Angular would otherwise
 * rename, such as `readonly` to `readOnly`. Returns the property names by lowercase tag name, or
 * `null` if there are none. Other bindings need no metadata because Angular doesn't rename them.
 */
export function getCustomElementsManifestExactPropertyNames(
  template: Node[],
  index: CustomElementsManifestIndex | null,
): ReadonlyMap<string, ReadonlySet<string>> | null {
  if (index === null || index.tagNames.size === 0) {
    return null;
  }
  const visitor = new ExactPropertyNameVisitor(index);
  visitAll(visitor, template);
  return visitor.propertyNames.size === 0 ? null : visitor.propertyNames;
}

/**
 * Checks whether two manifest indices declare the same set of remapped DOM property names
 * (`DOM_PROPERTY_REMAPPING`) for every custom element tag. Only changes to those names affect
 * generated template instructions and partial `customElementPropertyNames` metadata.
 */
export function haveSameCustomElementsManifestExactPropertyNames(
  a: CustomElementsManifestIndex | null,
  b: CustomElementsManifestIndex | null,
): boolean {
  if (a === b) {
    return true;
  }
  const exactA = collectRemappedManifestProperties(a);
  const exactB = collectRemappedManifestProperties(b);
  if (exactA.size !== exactB.size) {
    return false;
  }
  for (const [tag, propsA] of exactA) {
    const propsB = exactB.get(tag);
    if (propsB === undefined || propsA.size !== propsB.size) {
      return false;
    }
    for (const prop of propsA) {
      if (!propsB.has(prop)) {
        return false;
      }
    }
  }
  return true;
}

function collectRemappedManifestProperties(
  index: CustomElementsManifestIndex | null,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  if (index === null || index.tagNames.size === 0) {
    return result;
  }
  for (const tag of index.tagNames) {
    let remapped: Set<string> | undefined;
    for (const propName of DOM_PROPERTY_REMAPPING.keys()) {
      if (index.hasProperty(tag, propName)) {
        if (remapped === undefined) {
          remapped = new Set();
          result.set(tag, remapped);
        }
        remapped.add(propName);
      }
    }
  }
  return result;
}

class ExactPropertyNameVisitor extends RecursiveVisitor {
  readonly propertyNames = new Map<string, Set<string>>();

  constructor(private readonly index: CustomElementsManifestIndex) {
    super();
  }

  override visitElement(element: Element): void {
    for (const input of element.inputs) {
      // One-way `[class]` is specialized to a CSS class-map instruction before binding
      // specialization and never writes an element property. Two-way `[(class)]` compiles to
      // `ɵɵtwoWayProperty` and does use exact-name metadata.
      const isExactPropertyCandidate =
        (input.type === BindingType.Property && input.name !== 'class') ||
        input.type === BindingType.TwoWay;
      if (
        isExactPropertyCandidate &&
        DOM_PROPERTY_REMAPPING.has(input.name) &&
        this.index.hasProperty(element.name, input.name)
      ) {
        const tagName = normalizeCustomElementTagName(element.name);
        let names = this.propertyNames.get(tagName);
        if (names === undefined) {
          names = new Set();
          this.propertyNames.set(tagName, names);
        }
        names.add(input.name);
      }
    }
    super.visitElement(element);
  }
}
