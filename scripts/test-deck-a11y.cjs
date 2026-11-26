/** AST census: node scripts/test-deck-a11y.cjs [--list] [tsx files...].
 * No browser, backend, or live actions. Exits nonzero for inaccessible clicks. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const ts = require('typescript');
const root = path.join(__dirname, '..');

function census(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations = [];
  const controls = [];
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map(a => [a.name.text, a]));
      if (attrs.has('onClick')) {
        const tag = node.tagName.getText(tree);
        const at = `${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const expr = name => attrs.get(name)?.initializer?.getText(tree);
        // A decorative dismiss surface (modal backdrop) stays pointer-only: aria-hidden keeps it
        // out of the tab order and the accessibility tree; Esc is its keyboard path.
        if (expr('aria-hidden') === '"true"') { ts.forEachChild(node, visit); return; }
        if (!['button', 'a', 'input'].includes(tag)) {
          if (!['div', 'span'].includes(tag) || expr('role') !== '"button"' || !expr('tabIndex') || !['onKeyDown', 'onKeyUp'].some(k => expr(k))) {
            violations.push(`${at}: <${tag}> onClick needs button semantics, tabIndex, and keyboard activation`);
          }
        } else if (tag === 'button' && expr('type') !== '"button"') {
          violations.push(`${at}: button must specify type="button"`);
        } else if (tag === 'a' && !expr('href')) {
          violations.push(`${at}: anchor needs href for keyboard activation`);
        }
        const name = expr('aria-label') || expr('aria-labelledby') || (ts.isJsxElement(node.parent) ? node.parent.children.map(c => c.getText(tree)).join(' ').replace(/\s+/g, ' ').trim() : '');
        if (!name) violations.push(`${at}: control needs an accessible name`);
        controls.push(`${at} — ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { violations, controls };
}

// Guard the guard: regressions in either half of the contract must be caught.
for (const source of [
  '<div onClick={go}>Go</div>',
  '<span role="button" onClick={go}>Go</span>',
  '<div role="button" tabIndex={0} onClick={go}>Go</div>',
  '<section onClick={go}>Go</section>',
  '<a onClick={go}>Go</a>',
]) assert(census('negative.tsx', source).violations.length > 0, source);
assert.equal(census('positive.tsx', '<div role="button" tabIndex={0} onKeyDown={keys} onClick={go}>Go</div>').violations.length, 0);
assert.equal(census('positive.tsx', '<button type="button" onClick={go}>Go</button>').violations.length, 0);

// Exercise the shared role-button keyboard path without firing real deck actions.
const mod = { exports: {} };
const helper = ts.transpileModule(fs.readFileSync(path.join(root, 'src/flightdeck/deck/a11y.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
new Function('exports', helper)(mod.exports);
let clicks = 0;
const target = { click: () => clicks++, getAttribute: () => null };
function press(key, extra = {}) {
  let prevented = false;
  const event = { key, target, currentTarget: target, repeat: false, preventDefault: () => { prevented = true; }, stopPropagation() {}, ...extra };
  mod.exports.activateDeckControl(event);
  return prevented;
}
assert(press('Enter'));
assert(press(' '));
assert.equal(clicks, 2);
assert.equal(press('Escape'), false);
assert.equal(press('Enter', { target: {} }), false, 'nested controls must not activate the card');
press('Enter', { repeat: true });
press(' ', { currentTarget: { ...target, getAttribute: () => 'true' }, target: null });
const disabled = { ...target, getAttribute: () => 'true' };
press('Enter', { target: disabled, currentTarget: disabled });
assert.equal(clicks, 2, 'repeat and disabled controls must not click');

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : entry.name.endsWith('.tsx') ? [path.join(dir, entry.name)] : []);
}
const supplied = process.argv.slice(2).filter(arg => arg !== '--list');
const files = supplied.length ? supplied.map(file => path.resolve(file)) : filesIn(path.join(root, 'src/flightdeck/deck'));
const results = files.map(file => census(path.relative(root, file).replaceAll('\\', '/'), fs.readFileSync(file, 'utf8')));
const violations = results.flatMap(r => r.violations);
if (process.argv.includes('--list')) console.log(results.flatMap(r => r.controls).join('\n'));
for (const violation of violations) console.error(violation);
console.log(`Deck a11y census: ${files.length} TSX files, ${results.reduce((n, r) => n + r.controls.length, 0)} click targets, ${violations.length} violations`);
console.log('Keyboard activation and census regression checks: PASS');
process.exitCode = violations.length ? 1 : 0;
