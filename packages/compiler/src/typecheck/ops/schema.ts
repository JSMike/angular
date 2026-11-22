/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {BindingType} from '../../expression_parser/ast';
import {splitNsName} from '../../ml_parser/tags';
import {Element, HostElement, Template} from '../../render3/r3_ast';
import {DomElementSchemaRegistry} from '../../schema/dom_element_schema_registry';
import {TcbOp} from './base';
import {TcbExpr} from './codegen';
import {Context} from './context';
import {isValidJsIdentifier} from './custom_elements';
const REGISTRY = new DomElementSchemaRegistry();

/**
 * A `TcbOp` which feeds elements and unclaimed properties to the `DomSchemaChecker`.
 *
 * The DOM schema is not checked via TCB code generation. Instead, the `DomSchemaChecker` ingests
 * elements and property bindings and accumulates synthetic `ts.Diagnostic`s out-of-band. These are
 * later merged with the diagnostics generated from the TCB.
 *
 * For convenience, the TCB iteration of the template is used to drive the `DomSchemaChecker` via
 * the `TcbDomSchemaCheckerOp`.
 */
export class TcbDomSchemaCheckerOp extends TcbOp {
  constructor(
    private tcb: Context,
    private element: Element | Template | HostElement,
    private checkElement: boolean,
    private claimedInputs: Set<string> | null,
    private deepSchemaOnly: boolean = false,
  ) {
    super();
  }

  override get optional() {
    return false;
  }

  override execute(): TcbExpr | null {
    const element = this.element;
    const isTemplateElement = element instanceof Element || element instanceof Template;
    const bindings = isTemplateElement ? element.inputs : element.bindings;

    if (this.checkElement && isTemplateElement) {
      this.tcb.domSchemaChecker.checkElement(
        this.tcb.id,
        this.getTagName(element),
        element.startSourceSpan,
        this.tcb.schemas,
        this.tcb.hostIsStandalone,
      );
    }

    // TODO(alxhub): this could be more efficient.
    for (const binding of bindings) {
      const isPropertyBinding =
        binding.type === BindingType.Property || binding.type === BindingType.TwoWay;

      if (isPropertyBinding && this.claimedInputs?.has(binding.name)) {
        // Skip this binding as it was claimed by a directive.
        continue;
      }

      const isManifestTwoWayClass =
        binding.type === BindingType.TwoWay &&
        binding.name === 'class' &&
        isTemplateElement &&
        element instanceof Element &&
        (this.tcb.env.config.customElementsManifestIndex?.getSchema(this.getTagName(element)) ??
          null) !== null;

      if (
        isPropertyBinding &&
        binding.name !== 'style' &&
        (binding.name !== 'class' || isManifestTwoWayClass)
      ) {
        if (isTemplateElement) {
          const tagName = this.getTagName(element);
          const manifestIndex = this.tcb.env.config.customElementsManifestIndex ?? null;
          // Custom Elements Manifest properties keep their exact names, such as `readonly`.
          // Other names map to DOM properties, such as `readOnly`.
          const propertyName =
            element instanceof Element &&
            manifestIndex !== null &&
            manifestIndex.hasProperty(tagName, binding.name)
              ? binding.name
              : REGISTRY.getMappedPropName(binding.name);
          // Defer undeclared identifier properties on manifest custom elements to
          // `TcbUnclaimedInputsOp` so both `HTMLElementTagNameMap` classes (including app-owned
          // manifests) and package class imports are checked against the real element class in
          // strict and non-strict modes. Keep `DomSchemaChecker` for `on*` / `:` security checks,
          // explicitly unbindable manifest properties, and non-identifier binding names (`[a+b]`).
          if (
            !this.deepSchemaOnly &&
            element instanceof Element &&
            manifestIndex !== null &&
            manifestIndex.getSchema(tagName) !== null &&
            !manifestIndex.isUnbindableProperty(tagName, propertyName) &&
            !manifestIndex.isUnbindableProperty(tagName, binding.name) &&
            !REGISTRY.validateProperty(propertyName).error &&
            isValidJsIdentifier(propertyName)
          ) {
            continue;
          }
          this.tcb.domSchemaChecker.checkTemplateElementProperty(
            this.tcb.id,
            tagName,
            propertyName,
            binding.sourceSpan,
            this.tcb.schemas,
            this.tcb.hostIsStandalone,
          );
        } else {
          // A direct binding to a host property.
          const propertyName = REGISTRY.getMappedPropName(binding.name);
          this.tcb.domSchemaChecker.checkHostElementProperty(
            this.tcb.id,
            element,
            propertyName,
            binding.keySpan,
            this.tcb.schemas,
          );
        }
      }
    }
    return null;
  }

  private getTagName(node: Element | Template): string {
    if (node instanceof Element) {
      return node.name;
    }

    return splitNsName(node.tagName!)[1];
  }
}
