import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bindRegistrationPrefill, consumeRegistrationPrefill, prefillKey } from '../../lib/client/registration-prefill.ts';
import { publicAuthEntry } from '../../lib/server/auth-entry.ts';

test('public form validates before navigation, trimmed handoff and exact CSP hash', async () => {
 const url=new URL('https://kapok.party/register');
 const response=await publicAuthEntry(new Request(url),url,'register');
 const html=await response.text();
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(script))).toString('base64');
 assert.ok(response.headers.get('content-security-policy').includes(`script-src 'sha256-${digest}'`));
 const dom=new JSDOM(html,{url:url.href,runScripts:'dangerously'});
 const form=dom.window.document.querySelector('form');
 form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
 assert.equal(dom.window.sessionStorage.length,0);
 assert.match(dom.window.document.querySelector('[role=alert]').textContent,/盘名/);
 form.elements.discName.value='  队员  ';form.elements.jerseyNumber.value=' 007 ';
 form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
 const saved=JSON.parse(dom.window.sessionStorage.getItem(prefillKey));
 assert.equal(saved.discName,'队员');assert.equal(saved.jerseyNumber,'007');
 assert.deepEqual(Object.keys(saved).sort(),['discName','expires','handoff','jerseyNumber']);
 dom.window.close();
});

test('actor binding, consumption, expiry, opener and storage failures fail closed',()=>{
 const dom=new JSDOM('',{url:'https://kapok.party/register/profile?prefill=0123456789abcdef0123456789abcdef'});globalThis.window=dom.window;
 const seed=(extra={})=>{window.history.replaceState(null,'','?prefill=0123456789abcdef0123456789abcdef');window.sessionStorage.setItem(prefillKey,JSON.stringify({handoff:'0123456789abcdef0123456789abcdef',discName:'队员',jerseyNumber:'007',expires:Date.now()+60000,...extra}));};
 seed();window.name='';bindRegistrationPrefill('a',true);
 assert.deepEqual(consumeRegistrationPrefill('a'),{discName:'队员',jerseyNumber:'007'});
 assert.equal(consumeRegistrationPrefill('a'),null);
 seed();bindRegistrationPrefill('a',true);bindRegistrationPrefill('b',true);assert.equal(consumeRegistrationPrefill('b'),null);
 for(const extra of [{expires:0},{expires:Date.now()+700000},{discName:' '.repeat(4)},{jerseyNumber:'12345'}]){seed(extra);bindRegistrationPrefill('a',true);assert.equal(consumeRegistrationPrefill('a'),null)}
 for(const query of ['?prefill=bad','?prefill=0123456789abcdef0123456789abcdef&prefill=0123456789abcdef0123456789abcdef','']){seed();window.history.replaceState(null,'','/register/profile'+query);bindRegistrationPrefill('a',true);assert.equal(consumeRegistrationPrefill('a'),null)}
 seed();bindRegistrationPrefill('a',false);assert.equal(window.sessionStorage.getItem(prefillKey),null);
 seed();window.opener={};bindRegistrationPrefill('a',true);assert.equal(consumeRegistrationPrefill('a'),null);window.opener=null;
 seed();bindRegistrationPrefill('a',true);const original=dom.window.Storage.prototype.removeItem;dom.window.Storage.prototype.removeItem=()=>{throw Error('blocked')};assert.equal(consumeRegistrationPrefill('a'),null);dom.window.Storage.prototype.removeItem=original;
 delete globalThis.window;dom.window.close();
});

test('storage unavailable exposes explicit verify-then-fill; login has no script',async()=>{
 const url=new URL('https://kapok.party/register');const html=await (await publicAuthEntry(new Request(url),url,'register')).text();
 const dom=new JSDOM(html,{url:url.href,runScripts:'dangerously',beforeParse(window){window.Storage.prototype.setItem=()=>{throw Error('blocked')}}});
 const form=dom.window.document.querySelector('form');form.elements.discName.value='甲';form.elements.jerseyNumber.value='01';form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
 assert.equal(dom.window.document.querySelector('#prefill-fallback').hidden,false);assert.match(dom.window.document.querySelector('[role=alert]').textContent,/重新填写/);dom.window.close();
 const login=await publicAuthEntry(new Request(url),url,'login');assert.doesNotMatch(await login.text(),/<script|<input/);assert.doesNotMatch(login.headers.get('content-security-policy'),/script-src/);
});


test('readable-but-unwritable stale record cannot survive fallback or canceled cleanup after recovery',async()=>{
 const url=new URL('https://kapok.party/register');
 const html=await (await publicAuthEntry(new Request(url),url,'register')).text();
 const old={handoff:'0123456789abcdef0123456789abcdef',discName:'旧资料',jerseyNumber:'09',expires:Date.now()+60000};
 let restore;
 const dom=new JSDOM(html,{url:url.href,runScripts:'dangerously',beforeParse(w){
   w.sessionStorage.setItem(prefillKey,JSON.stringify(old));
   const proto=w.Storage.prototype,set=proto.setItem,remove=proto.removeItem;
   proto.setItem=proto.removeItem=()=>{throw Error('unwritable')};restore=()=>{proto.setItem=set;proto.removeItem=remove};
 }});
 const form=dom.window.document.querySelector('form');form.elements.discName.value='新资料';form.elements.jerseyNumber.value='42';form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
 const cancel=dom.window.document.querySelector('a[href^="/login"]');const click=new dom.window.MouseEvent('click',{bubbles:true,cancelable:true});assert.equal(cancel.dispatchEvent(click),false);
 const fallback=dom.window.document.querySelector('#prefill-fallback');assert.equal(fallback.hidden,false);assert.equal(new URL(fallback.href).searchParams.has('prefill'),false);
 restore();globalThis.window=dom.window;
 window.history.replaceState(null,'','/register/profile?intent=register');bindRegistrationPrefill('new-actor',true);assert.equal(consumeRegistrationPrefill('new-actor'),null);
 delete globalThis.window;dom.window.close();
});
