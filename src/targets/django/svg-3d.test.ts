import test from 'node:test'
import assert from 'node:assert/strict'
import { exportVectorAsset } from './assets.ts'
import { unwrapFigma3dSvg } from './svg-3d.ts'

// Verbatim from Figma (19.11.2026): `exportAsync({ format: 'SVG_STRING' })` on a 160×100 rectangle
// with translateZ 40, rotateY 30 and its origin on the left edge.
const HINGE = `<svg width="166" height="106" viewBox="0 0 166 106" fill="none" xmlns="http://www.w3.org/2000/svg">
<foreignObject x="0" y="0" width="166" height="106" overflow="visible" data-figma-3d="true">
<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:166px;height:106px">
<div style="position:absolute;left:0;top:0;margin:0;width:160px;height:100px;transform-origin:0 0;transform:matrix(1, 0, 0, 1, 17.3684, 2.6316) translate(0px, 50%) translateZ(40px) rotateY(30deg) translate(0px, -50%);backface-visibility:hidden">
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" overflow="visible" style="position:absolute;left:0;top:0;overflow:visible">
<rect width="160" height="100" fill="#E5483F"/>
</svg>
</div>
</div>
</foreignObject>
</svg>
`

// The same for a rectangle rotated 20° in 2D and tilted in 3D: the 2D turn is in the wrapper too.
const ROTATED = `<svg width="170" height="119" viewBox="0 0 170 119" fill="none" xmlns="http://www.w3.org/2000/svg">
<foreignObject x="0" y="0" width="170" height="119" overflow="visible" data-figma-3d="true">
<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:170px;height:119px">
<div style="position:absolute;left:0;top:0;margin:0;width:160px;height:100px;transform-origin:0 0;transform:matrix(0.9397, -0.342, 0.342, 0.9397, -10.1621, 38.74) translate(50%, 50%) rotateX(25deg) rotateZ(10deg) translate(-50%, -50%)">
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" overflow="visible" style="position:absolute;left:0;top:0;overflow:visible">
<rect width="160" height="100" fill="#2F7BE5"/>
</svg>
</div>
</div>
</foreignObject>
</svg>
`

const PLAIN = `<svg width="160" height="100" viewBox="0 0 160 100" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="160" height="100" fill="#E5483F"/>
</svg>
`

test('the artwork comes back out of the 3D wrapper, at its own size and without any transform', () => {
  assert.equal(unwrapFigma3dSvg(HINGE), PLAIN)
  const rotated = unwrapFigma3dSvg(ROTATED)
  assert.match(rotated, /^<svg width="160" height="100" viewBox="0 0 160 100" fill="none" xmlns="http:\/\/www.w3.org\/2000\/svg">/)
  assert.match(rotated, /<rect width="160" height="100" fill="#2F7BE5"\/>/)
  assert.doesNotMatch(rotated, /foreignObject|transform|matrix|data-figma-3d|<div/)
})

test('a plain vector export is not touched', () => {
  assert.equal(unwrapFigma3dSvg(PLAIN), PLAIN)
})

test('a wrapper that is not exactly the one seen is handed back as it came', () => {
  // Something beside the object — defs the artwork may depend on.
  const withDefs = HINGE.replace('<foreignObject', '<defs><linearGradient id="g"/></defs>\n<foreignObject')
  assert.equal(unwrapFigma3dSvg(withDefs), withDefs)
  // Two objects.
  const twice = HINGE.replace('</foreignObject>', '</foreignObject>\n<foreignObject data-figma-3d="true"></foreignObject>')
  assert.equal(unwrapFigma3dSvg(twice), twice)
  // No artwork inside.
  const empty = HINGE.replace(/<svg xmlns[\s\S]*?<\/svg>\n<\/div>/, '</div>')
  assert.equal(unwrapFigma3dSvg(empty), empty)
  // The marker in a comment of an ordinary file.
  const mention = PLAIN.replace('<rect', '<!-- data-figma-3d="true" --><rect')
  assert.equal(unwrapFigma3dSvg(mention), mention)
})

test('a vector leaf with a 3D transform is exported as its flat artwork', async () => {
  const asset = await exportVectorAsset({ id: '8:4', name: 'hinge', exportAsync: async () => HINGE } as never)
  assert.equal(asset.kind, 'inline')
  assert.equal(asset.svg, PLAIN)
})
