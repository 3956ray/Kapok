import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { tokenizeTextLinks } from '../../lib/client/text-links.ts';

const { LearningText } = await import('../../app/components/learning-text.tsx');

test('link tokens preserve line breaks, parameters and adjacent punctuation', () => {
    const text = '看看https://example.test/a_(b)?x=1&lang=zh，谢谢！\n(www.example.test/资料)。\nhttp://example.test/end?x=y. HTTPS://example.test/#here!';
    const tokens = tokenizeTextLinks(text);
    assert.equal(tokens.map(token => token.text).join(''), text);
    assert.deepEqual(tokens.filter(token => token.href).map(token => token.href), [
        'https://example.test/a_(b)?x=1&lang=zh', 'https://www.example.test/资料', 'http://example.test/end?x=y', 'HTTPS://example.test/#here',
    ]);
    assert.deepEqual(tokenizeTextLinks('[http://[::1]:1010/path]。'), [
        { text: '[' }, { text: 'http://[::1]:1010/path', href: 'http://[::1]:1010/path' }, { text: ']。' },
    ]);
});

test('reading renders escaped body text and only HTTP(S) links in new tabs', () => {
    const text = '<img src=x onerror=alert(1)>\n<script>alert(2)</script> javascript:alert(3) data:text/html,hello ftp://www.example.test a@www.example.test javascript:https://bad.test\nwww.example.test?a=1&b=2';
    const html = renderToStaticMarkup(React.createElement(LearningText, { text }));
    const dom = new JSDOM(html);
    const { document } = dom.window;
    assert.equal(document.querySelector('p').textContent, text);
    assert.equal(document.querySelector('script,img'), null);
    const links = document.querySelectorAll('a');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://www.example.test/?a=1&b=2');
    assert.equal(links[0].target, '_blank');
    assert.equal(links[0].rel, 'noopener noreferrer');
    dom.window.close();
});


test('adjacent ASCII separators split URLs and preserve commas and semicolons in query values', () => {
    const text = 'https://example.test,https://other.test?q=one,two;three www.one.test;www.two.test';
    const tokens = tokenizeTextLinks(text);
    assert.equal(tokens.map(token => token.text).join(''), text);
    assert.deepEqual(tokens.filter(token => token.href).map(token => token.href), [
        'https://example.test', 'https://other.test?q=one,two;three', 'https://www.one.test', 'https://www.two.test',
    ]);
});

test('a clipped excerpt keeps a partial URL plain and earlier links clickable', async () => {
    const { TextLinks } = await import('../../app/components/learning-text.tsx');
    const text = 'https://example.test/complete 看 https://example.test/par';
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(TextLinks, { text, clipped: true })));
    assert.equal(dom.window.document.body.textContent, text);
    assert.deepEqual([...dom.window.document.links].map(a => a.href), ['https://example.test/complete']);
    dom.window.close();
});
