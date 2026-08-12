import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";

const ALLOWED_TAGS = [
	"p",
	"br",
	"strong",
	"em",
	"b",
	"i",
	"del",
	"s",
	"ul",
	"ol",
	"li",
	"blockquote",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"pre",
	"code",
	"hr",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"details",
	"summary",
	"a",
];

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function safeHttpsUrl(href: string): string | null {
	try {
		const parsed = new URL(href);
		return parsed.protocol === "https:" ? parsed.href : null;
	} catch {
		return null;
	}
}

export function renderSafeMarkdown(markdown: string): string {
	const renderer = new marked.Renderer();
	renderer.link = (href, title, text) => {
		const safeHref = safeHttpsUrl(href);
		if (!safeHref) return text;
		const safeTitle = title ? ` title="${escapeAttribute(title)}"` : "";
		return `<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noopener noreferrer"${safeTitle}>${text}</a>`;
	};
	renderer.image = (_href, _title, text) => text;

	const rendered = marked.parse(markdown, {
		renderer,
		async: false,
	}) as string;

	const forceSafeAnchor = (node: Element): void => {
		if (node.nodeName.toLowerCase() !== "a") return;
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noopener noreferrer");
	};
	DOMPurify.addHook("afterSanitizeAttributes", forceSafeAnchor);
	try {
		return DOMPurify.sanitize(rendered, {
			ALLOWED_TAGS,
			ALLOWED_ATTR: ["href", "target", "rel", "title", "open"],
			ALLOW_ARIA_ATTR: false,
			ALLOW_DATA_ATTR: false,
			ALLOWED_URI_REGEXP: /^https:\/\//i,
		});
	} finally {
		// removeHook removes the most recently registered hook of this type.
		DOMPurify.removeHook("afterSanitizeAttributes");
	}
}
