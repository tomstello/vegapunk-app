<script lang="ts">
	import { renderSafeMarkdown } from "./markdown";

	export let content: string;
	$: safeHtml = renderSafeMarkdown(content);
</script>

<!-- safeHtml is produced only by the post-Markdown DOMPurify allowlist in markdown.ts. -->
<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<div class="safe-markdown">{@html safeHtml}</div>

<style>
	.safe-markdown {
		font-size: 1rem;
		line-height: 1.62;
		overflow-wrap: anywhere;
	}
	.safe-markdown :global(> :first-child) {
		margin-top: 0;
	}
	.safe-markdown :global(> :last-child) {
		margin-bottom: 0;
	}
	.safe-markdown :global(p) {
		margin: 0.6rem 0;
	}
	.safe-markdown :global(h1),
	.safe-markdown :global(h2),
	.safe-markdown :global(h3),
	.safe-markdown :global(h4),
	.safe-markdown :global(h5),
	.safe-markdown :global(h6) {
		font-size: 1.05rem;
		font-weight: 700;
		line-height: 1.4;
		margin: 1rem 0 0.4rem;
	}
	.safe-markdown :global(ul),
	.safe-markdown :global(ol) {
		margin: 0.55rem 0;
		padding-left: 1.35rem;
	}
	.safe-markdown :global(li) {
		margin: 0.25rem 0;
	}
	.safe-markdown :global(a) {
		color: var(--vp-link);
		font-weight: 650;
		text-decoration: underline;
		text-underline-offset: 0.16em;
	}
	.safe-markdown :global(blockquote) {
		border-left: 3px solid #94a3b8;
		margin: 0.8rem 0;
		padding-left: 0.8rem;
	}
	.safe-markdown :global(pre) {
		background: #f1f5f9;
		border-radius: 0.5rem;
		overflow-x: auto;
		padding: 0.75rem;
	}
	.safe-markdown :global(code) {
		background: #f1f5f9;
		border-radius: 0.25rem;
		padding: 0.08rem 0.2rem;
	}
	.safe-markdown :global(pre code) {
		background: transparent;
		padding: 0;
	}
	.safe-markdown :global(table) {
		border-collapse: collapse;
		display: block;
		overflow-x: auto;
		width: 100%;
	}
	.safe-markdown :global(th),
	.safe-markdown :global(td) {
		border: 1px solid #cbd5e1;
		padding: 0.45rem;
		text-align: left;
	}
	.safe-markdown :global(details) {
		background: var(--vp-surface);
		border: 1px solid var(--vp-accordion-border);
		border-radius: 0.65rem;
		margin: 0.55rem 0;
	}
	.safe-markdown :global(summary) {
		align-items: center;
		color: var(--vp-accordion-summary);
		cursor: pointer;
		display: flex;
		font-weight: 700;
		min-height: 44px;
		padding: 0.6rem 0.75rem;
	}
	.safe-markdown :global(details > :not(summary)) {
		padding-left: 0.75rem;
		padding-right: 0.75rem;
	}
	.safe-markdown :global(details > :last-child) {
		padding-bottom: 0.65rem;
	}
</style>
