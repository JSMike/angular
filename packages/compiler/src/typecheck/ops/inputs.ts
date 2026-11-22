/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA} from '../../core';
import {AST, ASTWithSource, BindingType, Interpolation} from '../../expression_parser/ast';
import {ParseSourceSpan} from '../../parse_util';
import {BindingPropertyName, ClassPropertyName} from '../../property_mapping';
import {Identifiers as R3Identifiers} from '../../render3/r3_identifiers';
import {BoundAttribute, Element, Template} from '../../render3/r3_ast';
import type {Context} from './context';
import type {Scope} from './scope';
import {TcbDirectiveMetadata} from '../api';
import {TcbOp} from './base';
import {declareVariable, TcbExpr} from './codegen';
import {formatCustomElementPropertyAccess, isValidJsIdentifier} from './custom_elements';
import {
  CustomElementsManifestIndex,
  normalizeCustomElementTagName,
} from '../../schema/custom_elements_manifest_schema';
import {DomElementSchemaRegistry} from '../../schema/dom_element_schema_registry';
const REGISTRY = new DomElementSchemaRegistry();
import {tcbExpression, unwrapWritableSignal} from './expression';
import {
  checkUnsupportedFieldBindings,
  CustomFormControlType,
  customFormControlBannedInputFields,
  expandBoundAttributesForField,
} from './signal_forms';
import {getBoundAttributes, widenBinding} from './bindings';
import {LocalSymbol} from './references';
import {isUnsafeObjectKey} from '../../render3/util';

/**
 * Translates the given attribute binding to a `ts.Expression`.
 */
export function translateInput(value: AST | string, tcb: Context, scope: Scope): TcbExpr {
  if (typeof value === 'string') {
    // For regular attributes with a static string value, use the represented string literal.
    return new TcbExpr(TcbExpr.quoteAndEscape(value));
  } else {
    // Produce an expression representing the value of the binding.
    return tcbExpression(value, tcb, scope);
  }
}

/**
 * A `TcbOp` which generates code to check input bindings on an element that correspond with the
 * members of a directive.
 *
 * Executing this operation returns nothing.
 */
export class TcbDirectiveInputsOp extends TcbOp {
  constructor(
    private tcb: Context,
    private scope: Scope,
    private node: Template | Element,
    private dir: TcbDirectiveMetadata,
    private isFormControl: boolean = false,
    private customFormControlType: CustomFormControlType | null,
  ) {
    super();
  }

  override get optional() {
    return false;
  }

  override execute(): null {
    let dirId: TcbExpr | null = null;

    // TODO(joost): report duplicate properties
    const seenRequiredInputs = new Set<ClassPropertyName>();
    const boundAttrs = getBoundAttributes(this.dir, this.node);

    if (this.customFormControlType !== null) {
      checkUnsupportedFieldBindings(this.node, customFormControlBannedInputFields, this.tcb);
    }

    if (this.customFormControlType !== null || this.isFormControl) {
      const additionalBindings = expandBoundAttributesForField(
        this.dir,
        this.node,
        this.customFormControlType,
      );

      if (additionalBindings !== null) {
        boundAttrs.push(...additionalBindings);
      }
    }

    for (const attr of boundAttrs) {
      // For bound inputs, the property is assigned the binding expression.
      let assignment = widenBinding(
        translateInput(attr.value, this.tcb, this.scope),
        this.tcb,
        attr.value,
      );
      assignment.wrapForTypeChecker();

      for (const {fieldName, required, transformType, isSignal, isTwoWayBinding} of attr.inputs) {
        let target: TcbExpr;

        if (required) {
          seenRequiredInputs.add(fieldName);
        }

        // Note: There is no special logic for transforms/coercion with signal inputs.
        // For signal inputs, a `transformType` will never be set as we do not capture
        // the transform in the compiler metadata. Signal inputs incorporate their
        // transform write type into their member type, and we extract it below when
        // setting the `WriteT` of such `InputSignalWithTransform<_, WriteT>`.

        if (this.dir.coercedInputFields.has(fieldName)) {
          let type: TcbExpr;

          if (transformType !== undefined) {
            type = new TcbExpr(transformType);
          } else {
            // The input has a coercion declaration which should be used instead of assigning the
            // expression into the input field directly. To achieve this, a variable is declared
            // with a type of `typeof Directive.ngAcceptInputType_fieldName` which is then used as
            // target of the assignment.
            const dirTypeRef = this.tcb.env.referenceTcbValue(this.dir.ref);
            const propName = `ngAcceptInputType_${fieldName}`;
            const access = isUnsafeObjectKey(fieldName)
              ? `[${TcbExpr.quoteAndEscape(propName)}]`
              : `.${propName}`;
            type = new TcbExpr(`typeof ${dirTypeRef.print()}${access}`);
          }

          const id = new TcbExpr(this.tcb.allocateId());
          this.scope.addStatement(declareVariable(id, type));
          target = id;
        } else if (this.dir.undeclaredInputFields.has(fieldName)) {
          // If no coercion declaration is present nor is the field declared (i.e. the input is
          // declared in a `@Directive` or `@Component` decorator's `inputs` property) there is no
          // assignment target available, so this field is skipped.
          continue;
        } else if (
          !this.tcb.env.config.honorAccessModifiersForInputBindings &&
          this.dir.restrictedInputFields.has(fieldName)
        ) {
          // If strict checking of access modifiers is disabled and the field is restricted
          // (i.e. private/protected/readonly), generate an assignment into a temporary variable
          // that has the type of the field. This achieves type-checking but circumvents the access
          // modifiers.
          if (dirId === null) {
            dirId = this.scope.resolve(this.node, this.dir);
          }

          const id = new TcbExpr(this.tcb.allocateId());
          // Note: the indexed access type is used rather than a type query with a qualified name
          // (`typeof _t1.fieldName`) because, unlike the latter, it widens fresh literal types of
          // `readonly` fields (e.g. `@Input() readonly showBadge = false;` must still accept a
          // `true` binding).
          const type = new TcbExpr(
            `(typeof ${dirId.print()})[${TcbExpr.quoteAndEscape(fieldName)}]`,
          );
          const temp = declareVariable(id, type);
          this.scope.addStatement(temp);
          target = id;

          if (!this.dir.stringLiteralInputFields.has(fieldName) && attr.keySpan !== null) {
            // TypeScript does not treat the string literal in the indexed access type as a
            // reference to the class member, so emit a separate type query with a qualified name
            // that keeps a TypeScript-visible reference to the input's class member. The language
            // service relies on it e.g. to find references to a `readonly` input. Reading the
            // field is an error if it is private/protected, so diagnostics are ignored for this
            // statement; the assignment into the temporary variable remains fully type-checked.
            // Non-identifier field names cannot be expressed as a type query and are skipped.
            this.scope.addStatement(
              new TcbExpr(`null! as typeof ${dirId.print()}.${fieldName}`)
                .markIgnoreDiagnostics()
                .addParseSpanInfo(attr.keySpan),
            );
          }
        } else {
          if (dirId === null) {
            dirId = this.scope.resolve(this.node, this.dir);
          }

          // To get errors assign directly to the fields on the instance, using property access
          // when possible. String literal fields may not be valid JS identifiers so we use
          // literal element access instead for those cases.
          target = this.dir.stringLiteralInputFields.has(fieldName)
            ? new TcbExpr(`${dirId.print()}[${TcbExpr.quoteAndEscape(fieldName)}]`)
            : new TcbExpr(`${dirId.print()}.${fieldName}`);
        }

        // For signal inputs, we unwrap the target `InputSignal`. Note that
        // we intentionally do the following things:
        //   1. keep the direct access to `dir.[field]` so that modifiers are honored.
        //   2. follow the existing pattern where multiple targets assign a single expression.
        //      This is a significant requirement for language service auto-completion.
        if (isSignal) {
          const inputSignalBrandWriteSymbol = this.tcb.env.referenceExternalSymbol(
            R3Identifiers.InputSignalBrandWriteType.moduleName,
            R3Identifiers.InputSignalBrandWriteType.name,
          );

          target = new TcbExpr(`${target.print()}[${inputSignalBrandWriteSymbol.print()}]`);
        }

        if (attr.keySpan !== null) {
          target.addParseSpanInfo(attr.keySpan);
        }

        // Two-way bindings accept `T | WritableSignal<T>` so we have to unwrap the value.
        if (isTwoWayBinding && this.tcb.env.config.allowSignalsInTwoWayBindings) {
          assignment = unwrapWritableSignal(assignment, this.tcb);
        }

        // Finally the assignment is extended by assigning it into the target expression.
        assignment = new TcbExpr(`${target.print()} = ${assignment.print()}`);
      }

      assignment.addParseSpanInfo(attr.sourceSpan);

      // Ignore diagnostics for text attributes if configured to do so.
      if (!this.tcb.env.config.checkTypeOfAttributes && typeof attr.value === 'string') {
        assignment.markIgnoreDiagnostics();
      }

      this.scope.addStatement(assignment);
    }

    this.checkRequiredInputs(seenRequiredInputs);

    return null;
  }

  private checkRequiredInputs(seenRequiredInputs: Set<ClassPropertyName>): void {
    const missing: BindingPropertyName[] = [];

    for (const input of this.dir.inputs) {
      if (input.required && !seenRequiredInputs.has(input.classPropertyName)) {
        missing.push(input.bindingPropertyName);
      }
    }

    if (missing.length > 0) {
      this.tcb.oobRecorder.missingRequiredInputs(
        this.tcb.id,
        this.node,
        this.dir.name,
        this.dir.isComponent,
        missing,
      );
    }
  }
}

/**
 * A `TcbOp` which generates code to check "unclaimed inputs" - bindings on an element which were
 * not attributed to any directive or component, and are instead processed against the HTML element
 * itself.
 *
 * Currently, only the expressions of these bindings are checked. The targets of the bindings are
 * checked against the DOM schema via a `TcbDomSchemaCheckerOp`.
 *
 * Executing this operation returns nothing.
 */
export class TcbUnclaimedInputsOp extends TcbOp {
  constructor(
    private tcb: Context,
    private scope: Scope,
    private inputs: BoundAttribute[],
    private target: LocalSymbol,
    private claimedInputs: Set<string> | null,
  ) {
    super();
  }

  override get optional() {
    return false;
  }

  override execute(): null {
    // `this.inputs` contains only those bindings not matched by any directive. These bindings go to
    // the element itself.
    let elId: TcbExpr | null = null;
    const manifest = this.getManifestElement();

    if (manifest !== null && this.tcb.env.config.checkTypeOfAttributes) {
      // Check static attribute values against string-literal unions (from the manifest or inferred
      // from the element class via `_CemAttr`). Non-string types degrade to `string` because CEM
      // does not define how attribute strings coerce to other types.
      for (const attribute of manifest.element.attributes) {
        if (this.claimedInputs?.has(attribute.name)) {
          continue;
        }
        const attrSchema = manifest.index.getAttribute(manifest.element.name, attribute.name);
        if (attrSchema === null) {
          continue;
        }
        const keySpan = attribute.keySpan ?? attribute.sourceSpan;
        const valueExpr = translateInput(attribute.value, this.tcb, this.scope)
          .wrapForTypeChecker()
          .addParseSpanInfo(attribute.sourceSpan);
        if (attrSchema.checkType !== undefined) {
          if (attrSchema.checkTypeIsLiteralUnion && typeof attrSchema.checkType === 'string') {
            this.emitCheckedAssignment(
              attrSchema.checkType,
              keySpan,
              valueExpr,
              attribute.sourceSpan,
            );
          } else {
            const alias = this.tcb.allocateCemTypeAlias(attrSchema.checkType);
            if (alias === null) {
              if (attrSchema.property !== undefined) {
                this.tcb.useCemHelper('_CemAttr');
                const rawAlias = this.tcb.getCustomElementRawTypeAlias(manifest.element.name)!;
                const checkType = this.tcb.allocateCemTypeAlias(
                  `_CemAttr<${rawAlias}, ${TcbExpr.quoteAndEscape(attrSchema.property)}>`,
                )!;
                this.emitCheckedAssignment(checkType, keySpan, valueExpr, attribute.sourceSpan);
              }
              continue;
            }
            this.tcb.useCemHelper('_CemAttrValues');
            let checkExpr: string;
            if (attrSchema.property !== undefined) {
              this.tcb.useCemHelper('_CemAttr');
              const rawAlias = this.tcb.getCustomElementRawTypeAlias(manifest.element.name)!;
              const classAttr = `_CemAttr<${rawAlias}, ${TcbExpr.quoteAndEscape(attrSchema.property)}>`;
              checkExpr = attrSchema.checkTypeUsesUnreferencedGlobal
                ? classAttr
                : `[unknown] extends [${alias}] ? ${classAttr} : _CemAttrValues<Exclude<${alias}, undefined | null>>`;
            } else {
              checkExpr = `[unknown] extends [${alias}] ? string : _CemAttrValues<Exclude<${alias}, undefined | null>>`;
            }
            const checkType = this.tcb.allocateCemTypeAlias(checkExpr)!;
            this.emitCheckedAssignment(checkType, keySpan, valueExpr, attribute.sourceSpan);
          }
        } else if (attrSchema.property !== undefined) {
          this.tcb.useCemHelper('_CemAttr');
          const rawAlias = this.tcb.getCustomElementRawTypeAlias(manifest.element.name)!;
          const checkType = this.tcb.allocateCemTypeAlias(
            `_CemAttr<${rawAlias}, ${TcbExpr.quoteAndEscape(attrSchema.property)}>`,
          )!;
          this.emitCheckedAssignment(checkType, keySpan, valueExpr, attribute.sourceSpan);
        }
      }
    }

    // TODO(alxhub): this could be more efficient.
    for (const binding of this.inputs) {
      const isPropertyBinding =
        binding.type === BindingType.Property || binding.type === BindingType.TwoWay;

      if (isPropertyBinding && this.claimedInputs?.has(binding.name)) {
        // Skip this binding as it was claimed by a directive.
        continue;
      }

      const expr = widenBinding(
        tcbExpression(binding.value, this.tcb, this.scope),
        this.tcb,
        binding.value,
      );

      // The property that the binding sets. Custom Elements Manifest properties keep their exact
      // names, such as `readonly`. Other names map to DOM properties, such as `readOnly`.
      const propertyName =
        manifest !== null && manifest.index.hasProperty(manifest.element.name, binding.name)
          ? binding.name
          : REGISTRY.getMappedPropName(binding.name);

      const isStylingBinding =
        binding.name === 'style' ||
        (binding.type === BindingType.Property && binding.name === 'class');

      if (manifest !== null && isPropertyBinding && !isStylingBinding) {
        const keySpan = binding.keySpan ?? binding.sourceSpan;
        const property = manifest.index.getProperty(manifest.element.name, propertyName);
        if (property !== null) {
          if (!this.tcb.env.config.checkTypeOfInputBindings) {
            this.scope.addStatement(expr);
            continue;
          }
          const checkedExpression = this.prepareCheckedManifestValue(binding, expr);
          if (
            property.checkType !== undefined &&
            !property.checkTypeIsExternal &&
            typeof property.checkType === 'string'
          ) {
            this.emitCheckedAssignment(
              property.checkType,
              keySpan,
              checkedExpression,
              binding.sourceSpan,
            );
          } else {
            const rawInfo = this.tcb.getCustomElementRawTypeInfo(manifest.element.name)!;
            const quotedProp = TcbExpr.quoteAndEscape(propertyName);
            // When a package manifest's class imports were gated out (e.g. `tsconfig.spec.json`
            // without a side-effect import of the package), skip manifest types that name an
            // unreferenced global (such as `Selection`) so DOM global collisions do not cause
            // false errors; still check via `HTMLElementTagNameMap` if declared.
            const skipUnreferencedGlobal =
              Boolean(property.checkTypeUsesUnreferencedGlobal) && rawInfo.hasGatedClassImport;
            const alias =
              !skipUnreferencedGlobal && property.checkType !== undefined
                ? this.tcb.allocateCemTypeAlias(property.checkType)
                : null;
            if (alias !== null) {
              const helper = property.checkTypeUsesUnreferencedGlobal
                ? '_CemClassOrManifest'
                : '_CemManifestOrClass';
              this.tcb.useCemHelper(helper);
              const targetType =
                helper === '_CemClassOrManifest'
                  ? `_CemClassOrManifest<${rawInfo.alias}, ${quotedProp}, ${alias}>`
                  : `_CemManifestOrClass<${alias}, ${rawInfo.alias}, ${quotedProp}>`;
              this.emitCheckedMemberAssignment(
                targetType,
                propertyName,
                keySpan,
                checkedExpression,
                binding.sourceSpan,
              );
            } else {
              this.tcb.useCemHelper('_CemPropTarget');
              this.emitCheckedMemberAssignment(
                `_CemPropTarget<${rawInfo.alias}, ${quotedProp}>`,
                propertyName,
                keySpan,
                checkedExpression,
                binding.sourceSpan,
              );
            }
          }
          continue;
        }

        if (
          !manifest.index.isUnbindableProperty(manifest.element.name, propertyName) &&
          !manifest.index.isUnbindableProperty(manifest.element.name, binding.name) &&
          !REGISTRY.validateProperty(propertyName).error &&
          isValidJsIdentifier(propertyName)
        ) {
          const normalizedTag = normalizeCustomElementTagName(manifest.element.name);
          const isBaseDomProp = REGISTRY.hasProperty('unknown', propertyName, []);
          const hasPermissiveSchema = this.tcb.schemas.some(
            (schema) =>
              schema.name === CUSTOM_ELEMENTS_SCHEMA.name || schema.name === NO_ERRORS_SCHEMA.name,
          );
          if (!this.tcb.env.config.checkTypeOfInputBindings) {
            // In non-strict/basic modes, check property existence (and writability) against the
            // resolved class without checking the bound value type.
            if (!hasPermissiveSchema && !isBaseDomProp) {
              const rawInfo = this.tcb.getCustomElementRawTypeInfo(manifest.element.name)!;
              const helper = rawInfo.hasGatedClassImport ? '_CemGatedEl' : '_CemEl';
              this.tcb.useCemHelper(helper);
              const targetType = `${helper}<${rawInfo.alias}, ${TcbExpr.quoteAndEscape(normalizedTag)}, ${TcbExpr.quoteAndEscape(propertyName)}>`;
              this.emitCheckedMemberAssignment(
                targetType,
                propertyName,
                keySpan,
                new TcbExpr('(null! as any)'),
                binding.sourceSpan,
              );
            }
            this.scope.addStatement(expr);
            continue;
          }
          const checkedExpression = this.prepareCheckedManifestValue(binding, expr);
          const rawInfo = this.tcb.getCustomElementRawTypeInfo(manifest.element.name)!;
          const quotedProp = TcbExpr.quoteAndEscape(propertyName);
          let targetType: string;
          if (isBaseDomProp && !this.tcb.env.config.checkTypeOfDomBindings) {
            this.tcb.useCemHelper('_CemDomPropTarget');
            targetType = `_CemDomPropTarget<${rawInfo.alias}, ${quotedProp}>`;
          } else if (hasPermissiveSchema) {
            this.tcb.useCemHelper('_CemPropTarget');
            targetType = `_CemPropTarget<${rawInfo.alias}, ${quotedProp}>`;
          } else {
            // When a package manifest's class imports were gated out, allow undeclared properties
            // unless `HTMLElementTagNameMap` resolves the class so inherited base-class members
            // omitted from the manifest do not produce false errors in spec/unimported builds.
            const helper = rawInfo.hasGatedClassImport ? '_CemGatedEl' : '_CemEl';
            this.tcb.useCemHelper(helper);
            targetType = `${helper}<${rawInfo.alias}, ${TcbExpr.quoteAndEscape(normalizedTag)}, ${quotedProp}>`;
          }
          this.emitCheckedMemberAssignment(
            targetType,
            propertyName,
            keySpan,
            checkedExpression,
            binding.sourceSpan,
          );
          continue;
        }
      }

      if (this.tcb.env.config.checkTypeOfDomBindings && isPropertyBinding) {
        if (binding.name !== 'style' && binding.name !== 'class') {
          if (elId === null) {
            elId = this.scope.resolve(this.target);
          }
          // A direct binding to a property.
          const stmt = new TcbExpr(
            `${elId.print()}[${TcbExpr.quoteAndEscape(propertyName)}] = ${expr.wrapForTypeChecker().print()}`,
          ).addParseSpanInfo(binding.sourceSpan);
          this.scope.addStatement(stmt);
        } else {
          this.scope.addStatement(expr);
        }
      } else {
        // A binding to an animation, attribute, class or style. For now, only validate the right-
        // hand side of the expression.
        // TODO: properly check class and style bindings.
        this.scope.addStatement(expr);
      }
    }

    return null;
  }

  private prepareCheckedManifestValue(binding: BoundAttribute, expr: TcbExpr): TcbExpr {
    let checkedExpression = expr.wrapForTypeChecker();
    if (binding.type === BindingType.TwoWay && this.tcb.env.config.allowSignalsInTwoWayBindings) {
      checkedExpression = unwrapWritableSignal(checkedExpression, this.tcb);
    }
    if (isInterpolation(binding.value)) {
      // Type interpolation as `string`. Otherwise TypeScript can infer a literal union from
      // the target type for an expression such as `"" + ctx.variant`.
      checkedExpression = new TcbExpr(`(${checkedExpression.print()}) as string`).addParseSpanInfo(
        binding.value.sourceSpan,
      );
    }
    return checkedExpression;
  }

  private getManifestElement(): {index: CustomElementsManifestIndex; element: Element} | null {
    const index = this.tcb.env.config.customElementsManifestIndex ?? null;
    return index !== null &&
      this.target instanceof Element &&
      index.getSchema(this.target.name) !== null
      ? {index, element: this.target}
      : null;
  }

  private emitCheckedAssignment(
    checkType: string,
    keySpan: ParseSourceSpan,
    value: TcbExpr,
    sourceSpan: ParseSourceSpan,
  ): void {
    const id = new TcbExpr(this.tcb.allocateId());
    this.scope.addStatement(declareVariable(id, new TcbExpr(`(${checkType})`)));
    const target = new TcbExpr(id.print(true)).addParseSpanInfo(keySpan);
    this.scope.addStatement(
      new TcbExpr(`${target.print()} = ${value.print()}`).addParseSpanInfo(sourceSpan),
    );
  }

  private emitCheckedMemberAssignment(
    targetType: string,
    member: string,
    keySpan: ParseSourceSpan,
    value: TcbExpr,
    sourceSpan: ParseSourceSpan,
  ): void {
    const id = new TcbExpr(this.tcb.allocateId());
    this.scope.addStatement(declareVariable(id, new TcbExpr(`(${targetType})`)));
    const target = new TcbExpr(
      formatCustomElementPropertyAccess(id.print(true), member),
    ).addParseSpanInfo(keySpan);
    this.scope.addStatement(
      new TcbExpr(`${target.print()} = ${value.print()}`).addParseSpanInfo(sourceSpan),
    );
  }
}

function isInterpolation(value: AST): boolean {
  return (
    value instanceof Interpolation ||
    (value instanceof ASTWithSource && value.ast instanceof Interpolation)
  );
}
