import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateResearch,validatePaper} from '../dashboard/etf-schema.mjs';
const read=f=>JSON.parse(readFileSync(new URL('../dashboard/data/'+f,import.meta.url)));
test('ETF published research and account have the full rendering contract',()=>{
  assert.equal(validateResearch(read('etf-research.json')),true);
  assert.equal(validatePaper(read('etf-paper.json')),true);
});
test('Malformed numeric data and future or incompatible evidence cannot render as valid',()=>{
  const report=read('etf-research.json');report.runs[0].trades='<img src=x onerror=alert(1)>';
  assert.equal(validateResearch(report),false);
  const paper=read('etf-paper.json');paper.account.cash=null;
  assert.equal(validatePaper(paper),false);
  const future=read('etf-paper.json');future.generatedAt=Date.now()/1000+3600;
  assert.equal(validatePaper(future),false);
});
test('Unavailable account has an explicit error shape and never permits real orders',()=>{
  const r={modelVersion:'2026-09-13-etf-monthly-v1',generatedAt:Date.now()/1000,mode:'simulation',status:'source-error',realEnabled:false,account:null,error:'Input unavailable'};
  assert.equal(validatePaper(r),true);r.realEnabled=true;assert.equal(validatePaper(r),false);
});
