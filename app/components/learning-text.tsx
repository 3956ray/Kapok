import { tokenizeTextLinks } from '../../lib/client/text-links';

export function LearningText({ text }: { text: string }) {
    return <p className="learning-body">{tokenizeTextLinks(text).map(({ text, href }, index) =>
        href ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{text}</a> : text,
    )}</p>;
}
