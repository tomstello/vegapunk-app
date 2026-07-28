import { writable, type Writable } from 'svelte/store';

// Store to track loading state, simple boolean value
export const isLoading: Writable<boolean> = writable(false);

// Store for thumbs, assuming an array of any type
// If you know the specific type that should be in the array, replace `any` with that type
export const thumbs: Writable<any[]> = writable([]);

// Store for highlighted strings, which are likely strings
export const highlightedStrings: Writable<string[]> = writable([]);

// Origins allowed to act as the PARENT page of the embedded chat (i.e. to send
// chatParams — including the encrypted API key and system prompt — into the app
// via postMessage). Matched as exact hostnames or dot-boundary domain suffixes,
// never substrings: "vegapunk.evil.com" must not qualify by containing a keyword.
// The app's own origin (used by the /frame mock page) is always allowed and does
// not need to be listed here.
export const allowedParentHostnames: Writable<string[]> = writable([
    "localhost",
    "sveltekit-vercel-chatbot.vercel.app",
    "sveltekit-vercel-chatbot-git-dev-hauselins-projects.vercel.app",
    "sveltekit-vercel-chatbot-git-langchain-hauselins-projects.vercel.app",
    "vegapunk-walgreens.vercel.app",
    "vegapunkdoc.dev",
    "www.vegapunkdoc.dev",
]);

// Any subdomain of these domains may act as the parent (covers institutional
// Qualtrics instances like cornell.ca1.qualtrics.com).
export const allowedParentDomainSuffixes: Writable<string[]> = writable([
    "qualtrics.com",
]);
