import {Component, Directive} from '@angular/core';

@Directive({selector: '[forceFull]'})
export class ForceFull {}

@Component({
  selector: 'manifest-dom-properties',
  template: `
    <my-button
      [readonly]="readonly"
      [(formaction)]="formaction"
      [innerHTML]="html"
      [tabindex]="tabindex"
    ></my-button>
  `,
})
export class ManifestDomProperties {
  readonly = false;
  formaction = '/submit';
  html = '<strong>content</strong>';
  tabindex = 0;
}

@Component({
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
})
export class ManifestProperties {
  readonly = false;
  formaction = '/submit';
  html = '<strong>content</strong>';
}
