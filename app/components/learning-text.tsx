import { tokenizeTextLinks } from '../../lib/client/text-links';

export function TextLinks({ text, clipped = false }: { text: string; clipped?: boolean }) {
    // A server excerpt may end in the middle of a URL. Keep that last fragment plain.
    const end = clipped ? text.search(/[^\s，。！？；、（）【】「」]*$/u) : text.length;
    return <>{tokenizeTextLinks(text.slice(0, end)).map(({ text, href }, index) =>
        href ? <a className="body-link" key={index} href={href} target="_blank" rel="noopener noreferrer">{text}</a> : text,
    )}{text.slice(end)}</>;
}

export function LearningText({ text }: { text: string }) {
    return <p className="learning-body"><TextLinks text={text}/></p>;
}
