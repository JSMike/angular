function ManifestDomProperties_Template(rf, ctx) {
  if (rf & 1) {
    $r3$.ɵɵdomElementStart(0, "my-button", 0);
    $r3$.ɵɵtwoWayListener("formactionChange", function ManifestDomProperties_Template_my_button_formactionChange_0_listener($event) {
      $r3$.ɵɵtwoWayBindingSet(ctx.formaction, $event) || (ctx.formaction = $event);
      return $event;
    });
    $r3$.ɵɵdomElementEnd();
  }
  if (rf & 2) {
    $r3$.ɵɵdomProperty("readonly", ctx.readonly);
    $r3$.ɵɵtwoWayProperty("formaction", ctx.formaction, $r3$.ɵɵsanitizeUrl, true);
    $r3$.ɵɵdomProperty("innerHTML", ctx.html, $r3$.ɵɵsanitizeHtml)("tabIndex", ctx.tabindex);
  }
}

…

function ManifestProperties_Template(rf, ctx) {
  if (rf & 1) {
    $r3$.ɵɵelementStart(0, "my-button", 0);
    $r3$.ɵɵtwoWayListener("formactionChange", function ManifestProperties_Template_my_button_formactionChange_0_listener($event) {
      $r3$.ɵɵtwoWayBindingSet(ctx.formaction, $event) || (ctx.formaction = $event);
      return $event;
    });
    $r3$.ɵɵelementEnd();
  }
  if (rf & 2) {
    $r3$.ɵɵproperty("readonly", ctx.readonly, null, true);
    $r3$.ɵɵtwoWayProperty("formaction", ctx.formaction, $r3$.ɵɵsanitizeUrl, true);
    $r3$.ɵɵproperty("innerHTML", ctx.html, $r3$.ɵɵsanitizeHtml, true);
  }
}
