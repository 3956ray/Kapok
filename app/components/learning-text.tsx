import { tokenizeTextLinks } from '../../lib/client/text-links';

export function TextLinks({ text }: { text: string }) {
    return <>{tokenizeTextLinks(text).map(({ text, href }, index) =>
        href ? <a className="body-link" key={index} href={href} target="_blank" rel="noopener noreferrer">{text}</a> : text,
    )}</>;
}

export function LearningText({ text }: { text: string }) {
    return <p className="learning-body"><TextLinks text={text}/></p>;
}
