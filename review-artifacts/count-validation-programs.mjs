import {performCompilation,readConfiguration} from './compiler-cli-instrumented.mjs';
const config=readConfiguration('tsconfig.app.json');
const result=performCompilation({rootNames: config.rootNames, options: {...config.options,noEmit:true}});
console.log(JSON.stringify({entries:config.options.customElementsManifests.length,programs:globalThis.__cemReviewPrograms,errors:result.diagnostics.filter(d=>d.category===1).length},null,2));
