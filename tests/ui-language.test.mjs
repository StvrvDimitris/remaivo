import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const scratch = path.resolve('work/language-tests');
fs.mkdirSync(scratch, { recursive: true });
for (const name of ['translations-el', 'ui-language', 'i18n', 'dialog-ui']) {
  const extension = ['i18n', 'dialog-ui'].includes(name) ? 'tsx' : 'ts';
  const source = fs.readFileSync(`app/${name}.${extension}`, 'utf8').replace(/from (["'])\.\/(translations-el|ui-language|i18n)\1/g, 'from "./$2.mjs"');
  fs.writeFileSync(path.join(scratch, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText);
}
const { normalizeLanguage, translate, translateInsight } = await import(pathToFileURL(path.join(scratch, 'ui-language.mjs')));
const { greek } = await import(pathToFileURL(path.join(scratch, 'translations-el.mjs')));
const { LanguageProvider, LanguageSelect } = await import(pathToFileURL(path.join(scratch, 'i18n.mjs')));
const { DialogFrame, DialogSubmit } = await import(pathToFileURL(path.join(scratch, 'dialog-ui.mjs')));

test('English stays unchanged; Greek is explicit and unknown user text stays intact', () => {
  assert.equal(normalizeLanguage('el'), 'el');
  assert.equal(normalizeLanguage('bad'), 'en');
  assert.equal(translate('Settings', 'en'), 'Settings');
  assert.equal(translate('Settings', 'el'), 'Ρυθμίσεις');
  assert.equal(translate('Trading 212 VWCE', 'el'), 'Trading 212 VWCE');
});

test('Every fixed translation used by the UI has a Greek entry or is a preserved brand/key', () => {
  const preserved = new Set(['R', 'M', 'Esc', 'Remaivo']);
  for (const file of fs.readdirSync('app').filter(name => name.endsWith('.tsx'))) {
    const tree = ts.createSourceFile(file, fs.readFileSync(`app/${file}`, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tr' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text;
        assert.ok(greek[key] || preserved.has(key), `${file}: ${key}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
});

test('Generated Insights commentary translates without changing descriptions or amounts', () => {
  const original = 'My Gym was the largest description at 42% across 1 transaction.';
  assert.equal(translateInsight(original, 'en'), original);
  assert.equal(translateInsight(original, 'el'), 'My Gym ήταν η μεγαλύτερη περιγραφή με 42%, σε 1 συναλλαγή.');
  assert.match(translateInsight('Fuel increased by €40 (32%) versus the comparison period.', 'el'), /^Fuel αυξήθηκε κατά €40 \(32%\)/);
});

test('Greek selection and shared dialog actions render without altering native form submission', () => {
  const markup = renderToStaticMarkup(React.createElement(LanguageProvider, {initialLanguage:'el'}, React.createElement(React.Fragment, null,
    React.createElement(LanguageSelect), React.createElement(DialogFrame, {currency:'EUR',close:()=>{}}, React.createElement('form', null,
      React.createElement('input', {name:'amount',required:true}), React.createElement(DialogSubmit, {busy:false,label:'Αποθήκευση'}))))));
  assert.match(markup, /Γλώσσα/);
  assert.match(markup, /value="el" selected=""/);
  assert.match(markup, /Ακύρωση/);
  assert.match(markup, /form="[^"]+-form-0"/);
  assert.equal((markup.match(/Αποθήκευση/g)||[]).length, 1);
});
