import { env } from '$env/dynamic/private';
import { ENCRYPTION_IV, ENCRYPTION_KEY } from '$env/static/private';
import type { ChatParamsType } from '$lib/chatParams';
import { HfInference } from '@huggingface/inference';
import { ChatOpenAI } from '@langchain/openai';
import { decrypt } from './utils';

// OpenRouter routing policy, enforced SERVER-side so nothing sent by the client
// can weaken it (chatParams are attacker-controllable; env vars are not).
//   OPENROUTER_ZDR             "true" (default) restricts routing to endpoints
//                              certified Zero Data Retention; "false" opts out.
//   OPENROUTER_PROVIDER_ONLY   optional comma-separated endpoint allowlist, e.g.
//                              "amazon-bedrock/us" to pin US-resident inference.
// https://openrouter.ai/docs/features/zdr
// https://openrouter.ai/docs/features/provider-routing
const isOpenRouter = (baseURL?: string): boolean => {
    try {
        return baseURL ? new URL(baseURL).hostname === 'openrouter.ai' : false;
    } catch {
        return false;
    }
};

const openRouterProviderPrefs = (): Record<string, unknown> | undefined => {
    if ((env.OPENROUTER_ZDR ?? 'true').toLowerCase() === 'false') return undefined;
    const prefs: Record<string, unknown> = { zdr: true };
    const only = (env.OPENROUTER_PROVIDER_ONLY ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (only.length > 0) prefs.only = only;
    return prefs;
};

// Anthropic prompt caching (server-enforced, like the routing policy):
//   OPENROUTER_PROMPT_CACHING  "true" (default) sends OpenRouter's top-level
//   automatic cache_control for Anthropic models. OpenRouter translates it
//   into trailing breakpoints per provider (incl. Amazon Bedrock) and
//   advances the breakpoint as the conversation grows. Cache reads bill at
//   0.1x input price, writes at 1.25x. Opus-class models need a >=4096-token
//   prefix before caching engages — the system prompt + FAQ + first exchange
//   reach that from roughly the second turn, which is where the token volume
//   lives. https://openrouter.ai/docs/features/prompt-caching
const openRouterCacheControl = (chatParams: ChatParamsType): Record<string, unknown> | undefined => {
    if (!isOpenRouter(chatParams.model.baseURL)) return undefined;
    if (!chatParams.model.name.startsWith('anthropic/')) return undefined;
    if ((env.OPENROUTER_PROMPT_CACHING ?? 'true').toLowerCase() === 'false') return undefined;
    return { type: 'ephemeral' };
};

export const createOpenAIProvider = (chatParams: ChatParamsType, enableStreaming = false) => {
    //https://v02.api.js.langchain.com/classes/langchain_openai.ChatOpenAI.html
    // Log the parameters to debug
    const providerPrefs = isOpenRouter(chatParams.model.baseURL) ? openRouterProviderPrefs() : undefined;
    const cacheControl = openRouterCacheControl(chatParams);
    const modelKwargs: Record<string, unknown> = {
        ...(providerPrefs ? { provider: providerPrefs } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
    };
    return new ChatOpenAI({
        streaming: enableStreaming,
        model: chatParams.model.name,
        apiKey: decrypt(ENCRYPTION_KEY, ENCRYPTION_IV, chatParams.model.apiKeyEncrypted),
        maxTokens: chatParams.model.options.maxTokens,
        temperature: chatParams.model.options.temperature,
        topP: chatParams.model.options.topP,
        stop: chatParams.model.options.stop,
        frequencyPenalty: chatParams.model.options.frequencyPenalty,
        presencePenalty: chatParams.model.options.presencePenalty,
        maxRetries: chatParams.model.options.maxRetries,
        timeout: chatParams.model.options.timeout,
        configuration: {
            baseURL: chatParams.model.baseURL,
        },
        ...(Object.keys(modelKwargs).length > 0 ? { modelKwargs } : {}),
    });
};

export const createHuggingFaceProvider = (chatParams: ChatParamsType) => {
    // https://www.npmjs.com/package/@huggingface/inference
    // BUT: maybe have to set up a custom langchain provider instead
    const inference = new HfInference(decrypt(ENCRYPTION_KEY, ENCRYPTION_IV, chatParams.model.apiKeyEncrypted));
    return inference.endpoint(chatParams.model.baseURL);
};


export const createOnlineSearchProvider = (chatParams: ChatParamsType, enableStreaming = false) => {
    //https://v02.api.js.langchain.com/classes/langchain_openai.ChatOpenAI.html
    // The same ZDR policy is applied here deliberately: perplexity/sonar-pro has
    // no ZDR-certified endpoints, so with OPENROUTER_ZDR=true (the default)
    // online search FAILS CLOSED rather than silently routing chat content to a
    // data-retaining endpoint. Studies that need online search must explicitly
    // set OPENROUTER_ZDR=false (and accept the retention implications).
    const providerPrefs = openRouterProviderPrefs();
    return new ChatOpenAI({
        streaming: enableStreaming,
        model: "perplexity/sonar-pro",
        apiKey: decrypt(ENCRYPTION_KEY, ENCRYPTION_IV, chatParams.model.apiKeyEncrypted),
        configuration: {
            baseURL: "https://openrouter.ai/api/v1",
        },
        maxRetries: chatParams.model.options.maxRetries,
        timeout: chatParams.model.options.timeout,
        ...(providerPrefs ? { modelKwargs: { provider: providerPrefs } } : {}),
    });
};
