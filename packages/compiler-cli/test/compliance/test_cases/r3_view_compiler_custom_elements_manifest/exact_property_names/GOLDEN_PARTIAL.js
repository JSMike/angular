/****************************************************************************************************
 * PARTIAL FILE: test.js
 ****************************************************************************************************/
import { Component, Directive } from '@angular/core';
import * as i0 from "@angular/core";
export class ForceFull {
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "0.0.0-PLACEHOLDER", ngImport: i0, type: ForceFull, deps: [], target: i0.ɵɵFactoryTarget.Directive });
    static ɵdir = i0.ɵɵngDeclareDirective({ minVersion: "14.0.0", version: "0.0.0-PLACEHOLDER", type: ForceFull, isStandalone: true, selector: "[forceFull]", ngImport: i0 });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "0.0.0-PLACEHOLDER", ngImport: i0, type: ForceFull, decorators: [{
            type: Directive,
            args: [{ selector: '[forceFull]' }]
        }] });
export class ManifestDomProperties {
    readonly = false;
    formaction = '/submit';
    html = '<strong>content</strong>';
    tabindex = 0;
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "0.0.0-PLACEHOLDER", ngImport: i0, type: ManifestDomProperties, deps: [], target: i0.ɵɵFactoryTarget.Component });
    static ɵcmp = i0.ɵɵngDeclareComponent({ minVersion: "22.1.0", version: "0.0.0-PLACEHOLDER", type: ManifestDomProperties, isStandalone: true, selector: "manifest-dom-properties", ngImport: i0, template: `
    <my-button
      [readonly]="readonly"
      [(formaction)]="formaction"
      [innerHTML]="html"
      [tabindex]="tabindex"
    ></my-button>
  `, isInline: true, customElementPropertyNames: { "my-button": ["readonly", "formaction", "innerHTML"] } });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "0.0.0-PLACEHOLDER", ngImport: i0, type: ManifestDomProperties, decorators: [{
            type: Component,
            args: [{
                    selector: 'manifest-dom-properties',
                    template: `
    <my-button
      [readonly]="readonly"
      [(formaction)]="formaction"
      [innerHTML]="html"
      [tabindex]="tabindex"
    ></my-button>
  `,
                }]
        }] });
export class ManifestProperties {
    readonly = false;
    formaction = '/submit';
    html = '<strong>content</strong>';
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "0.0.0-PLACEHOLDER", ngImport: i0, type: ManifestProperties, deps: [], target: i0.ɵɵFactoryTarget.Component });
    static ɵcmp = i0.ɵɵngDeclareComponent({ minVersion: "22.1.0", version: "0.0.0-PLACEHOLDER", type: ManifestProperties, isStandalone: true, selector: "manifest-properties", ngImport: i0, template: `
    <my-button
      forceFull
      [readonly]="readonly"
      [(formaction)]="formaction"
      [innerHTML]="html"
    ></my-button>
  `, isInline: true, customElementPropertyNames: { "my-button": ["readonly", "formaction", "innerHTML"] }, dependencies: [{ kind: "directive", type: ForceFull, selector: "[forceFull]" }] });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "0.0.0-PLACEHOLDER", ngImport: i0, type: ManifestProperties, decorators: [{
            type: Component,
            args: [{
                    selector: 'manifest-properties',
                    imports: [ForceFull],
                    template: `
    <my-button
      forceFull
      [readonly]="readonly"
      [(formaction)]="formaction"
      [innerHTML]="html"
    ></my-button>
  `,
                }]
        }] });

/****************************************************************************************************
 * PARTIAL FILE: test.d.ts
 ****************************************************************************************************/
import * as i0 from "@angular/core";
export declare class ForceFull {
    static ɵfac: i0.ɵɵFactoryDeclaration<ForceFull, never>;
    static ɵdir: i0.ɵɵDirectiveDeclaration<ForceFull, "[forceFull]", never, {}, {}, never, never, true, never>;
}
export declare class ManifestDomProperties {
    readonly: boolean;
    formaction: string;
    html: string;
    tabindex: number;
    static ɵfac: i0.ɵɵFactoryDeclaration<ManifestDomProperties, never>;
    static ɵcmp: i0.ɵɵComponentDeclaration<ManifestDomProperties, "manifest-dom-properties", never, {}, {}, never, never, true, never>;
}
export declare class ManifestProperties {
    readonly: boolean;
    formaction: string;
    html: string;
    static ɵfac: i0.ɵɵFactoryDeclaration<ManifestProperties, never>;
    static ɵcmp: i0.ɵɵComponentDeclaration<ManifestProperties, "manifest-properties", never, {}, {}, never, never, true, never>;
}

