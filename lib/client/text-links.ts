export type TextLinkToken = { text: string; href?: string };

const urlStart = /https?:\/\/|www\./gi;
const insideWord = /[A-Za-z0-9_@./%+\-\\]/;
const stopsUrl = /[\s<>"'`\\，。！？；：、…（）【】《》〈〉「」『』“”‘’［］｛｝]/u;
const nextUrl = /[,;](?:https?:\/\/|www\.)[^/\s,;]/iy;
const trailingPunctuation = /[.,!?;:]+$/;

function urlEnd(text: string, start: number) {
    let end = start;
    let parentheses = 0;
    let brackets = 0;
    while (end < text.length) {
        const char = text[end];
        const code = char.charCodeAt(0);
        if (code <= 0x1f || code === 0x7f || stopsUrl.test(char) || (char === ')' && !parentheses) || (char === ']' && !brackets) || char === '}') break;
        if (!parentheses && !brackets && (char === ',' || char === ';')) {
            nextUrl.lastIndex = end;
            if (nextUrl.test(text)) break;
        }
        if (char === '(') parentheses++;
        if (char === ')') parentheses--;
        if (char === '[') brackets++;
        if (char === ']') brackets--;
        end++;
    }
    return end;
}

export function tokenizeTextLinks(text: string): TextLinkToken[] {
    const tokens: TextLinkToken[] = [];
    let offset = 0;
    for (const match of text.matchAll(urlStart)) {
        const start = match.index;
        const isWww = match[0].toLowerCase() === 'www.';
        if (start < offset || (start > 0 && insideWord.test(text[start - 1]))) continue;
        if (/(?:javascript|data|vbscript):$/i.test(text.slice(Math.max(0, start - 11), start))) continue;

        const label = text.slice(start, urlEnd(text, start)).replace(trailingPunctuation, '');
        const href = isWww ? 'https://' + label : label;
        if (!/^https?:\/\/[^/]/i.test(href)) continue;
        let url: URL;
        try { url = new URL(href); }
        catch { continue; }
        if (!url.hostname || url.username || url.password || (isWww && !/^www\..+/i.test(url.hostname))) continue;

        if (start > offset) tokens.push({ text: text.slice(offset, start) });
        tokens.push({ text: label, href });
        offset = start + label.length;
    }
    if (offset < text.length) tokens.push({ text: text.slice(offset) });
    return tokens;
}
