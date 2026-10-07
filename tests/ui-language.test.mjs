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
const { normalizeLanguage, translate, translateInsight, formatPlanEvent } = await import(pathToFileURL(path.join(scratch, 'ui-language.mjs')));
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


test('Historical and newly generated Plan events localize only on display', () => {
  const funding = Object.freeze({kind:'funding',detail:'Period funding set to 1085.39. No account money was moved.'});
  assert.equal(formatPlanEvent(funding,'en','EUR'),funding.detail);
  const expectedMoney = new Intl.NumberFormat('el-GR',{style:'currency',currency:'EUR'}).format(1085.39);
  assert.equal(formatPlanEvent(funding,'el','EUR'),`Η χρηματοδότηση περιόδου ορίστηκε σε ${expectedMoney}. Δεν μετακινήθηκαν χρήματα λογαριασμών.`);
  const allocation = {kind:'allocation',detail:'Caffeine assigned 50. Matching activity and planned payments are covered inside this amount.'};
  assert.match(formatPlanEvent(allocation,'el','EUR'),/^Στον φάκελο Caffeine κατανεμήθηκαν/);
  for (const event of [
    {kind:'setup',detail:'Current Plan created from opening balances.'},
    {kind:'configuration',detail:'Plan settings updated for the current period. Earlier periods retain their settings.'},
    {kind:'allocation',detail:'Bucket protection restored.'},
    {kind:'allocation',detail:'Unused bucket protection released to everyday spending.'},
    {kind:'allocation',detail:'12.5 reassigned from Everyday to Fuel for this period.'},
    {kind:'payment',detail:'My transfer: 3 recorded on 2026-10-07.'},
    {kind:'payment',detail:'My transfer: 3 recorded on 2026-10-07 by matching existing activity.'},
    {kind:'schedule',detail:'My plan: occurrence skipped.'},
    {kind:'schedule',detail:'My plan: due date changed.'},
    {kind:'assignment',detail:'My purchase: funding assignments updated.'},
  ]) {
    assert.equal(formatPlanEvent(event,'en','EUR'),event.detail);
    assert.notEqual(formatPlanEvent(event,'el','EUR'),event.detail);
  }
  assert.equal(formatPlanEvent({kind:'unknown',detail:'Keep this original audit record'},'el','EUR'),'Keep this original audit record');
});

test('Daily allowance and other explanatory dialog notes have Greek translations', () => {
  const note='Bucket spending and committed payments are covered separately. Allowance is a pacing guide; review upcoming payments and your plan for cash timing. Weeks stop at the current period boundary.';
  assert.match(translate(note,'el'),/^Τα έξοδα φακέλων/);
  assert.equal(translate(note,'en'),note);
  for (const key of ['Protected allocations do not move money between accounts. They describe its purpose.','A covered payment replaces the unpaid amount or consumes its bucket. It is counted once.']) assert.notEqual(translate(key,'el'),key);
});
