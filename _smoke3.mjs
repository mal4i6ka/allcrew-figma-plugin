
import { buildDesignTokens } from './src/targets/design-tokens.ts'
const graph = {
  fileName: 'DS', collections: [{ id: 'c1', name: 'P', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] }],
  variables: [{ id: 'v1', name: 'bg/surface', collectionId: 'c1', resolvedType: 'COLOR', valuesByMode: { m1: { r:1,g:1,b:1,a:1 }, m2: { r:0,g:0,b:0,a:1 } } }],
  textStyles: [],
}
function opts(over) { return { target:'design-tokens', scopeMode:'page', modules:{tokens:true,templates:false,i18n:false,animation:false}, targetOptions:{platform:'django',framework:'none',bootstrapFidelity:'tokens',bootstrapSource:'vendored',bootstrapVersion:'5.3'}, tokens: Object.assign({ inlinePrimitives:true, flattenAliases:false, themeAttribute:'data-theme-name', emitJson:true, emitScss:false, emitModuleFiles:true, cssModulesGlobal:true, typoExtract:true, typoScaleOnly:true, typoShorthand:false, typoNaming:'tshirt' }, over), i18n:{wrapTranslate:true,sourceLanguage:'en'}, delivery:{endpoint:'',secret:'',onExport:false} } }
const withModules = buildDesignTokens(graph, opts({}))
const noModules = buildDesignTokens(graph, opts({ emitModuleFiles:false }))
const noGlobal = buildDesignTokens(graph, opts({ emitModuleFiles:true, cssModulesGlobal:false }))
console.log('emitModuleFiles=true  files:', Object.keys(withModules.files).sort().join(', '))
console.log('emitModuleFiles=false files:', Object.keys(noModules.files).sort().join(', '))
console.log('cssModulesGlobal=true  module css has :global():', /:global\(/.test(withModules.files['light.module.css']||''))
console.log('cssModulesGlobal=false module css has :global():', /:global\(/.test(noGlobal.files['light.module.css']||''))
