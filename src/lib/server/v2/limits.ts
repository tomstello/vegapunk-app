export const V2_PROTOCOL_VERSION = 2 as const;

export const SESSION_TTL_SECONDS = 60 * 60;
export const CHECKPOINT_HANDLE_TTL_SECONDS = 24 * 60 * 60;
export const MAX_CLOCK_SKEW_SECONDS = 30;
export const MAX_SESSION_REQUEST_BYTES = 1_024;

export const MAX_TURNS = 35;
export const MAX_USER_CODE_POINTS = 1_500;
// Emergency capture ceiling, not a provider-generation target. The provider is
// allowed to stop naturally (no max_tokens is sent); this bound exists only so
// one pathological answer cannot make the canonical Qualtrics JSON unsavable.
export const MAX_ASSISTANT_CODE_POINTS = 16_000;
export const MAX_HISTORY_MESSAGES = MAX_TURNS * 2;
export const MAX_SNAPSHOT_MESSAGES = 200;
export const MAX_CAPTURE_ERRORS = 20;
export const MAX_CHAT_REQUEST_BYTES = 340_000;
export const MAX_CONTEXT_UTF8_BYTES = 320_000;

export const MAX_TRANSCRIPT_UTF16_CODE_UNITS = 240_000;
export const MAX_TRANSCRIPT_UTF8_BYTES = 280_000;
export const MAX_CHECKPOINT_REQUEST_BYTES = 400_000;
// Qualtrics Embedded Data values are limited by bytes, not JavaScript string
// length. This is a per-field UTF-8 byte ceiling.
export const CHECKPOINT_CHUNK_SIZE = 12_000;
export const CHECKPOINT_CHUNK_COUNT = 24;

export const OPENROUTER_FIRST_BYTE_TIMEOUT_MS = 45_000;
export const OPENROUTER_STREAM_IDLE_TIMEOUT_MS = 30_000;
export const OPENROUTER_HARD_TIMEOUT_MS = 180_000;
export const OPENROUTER_MAX_ATTEMPTS = 2;
export const OPENROUTER_MAX_RETRY_AFTER_MS = 5_000;
export const OPENROUTER_DEFAULT_RETRY_DELAY_MS = 500;
export const OPENROUTER_RETRYABLE_STATUS_CODES = Object.freeze([429, 500, 502, 503, 504] as const);
export const MAX_PROVIDER_SSE_EVENT_CHARS = 65_536;
// Per-attempt upstream deadline for the checkpoint store (Qualtrics or S3).
// The browser's 75-second request timeout and 120-second lease guard are sized
// around this value; change them together.
export const CHECKPOINT_UPSTREAM_TIMEOUT_MS = 20_000;

// This object is part of every study configuration hash. Keep it JSON-only and
// version substantive policy changes through the corresponding configVersion.
// The checkpointChunk* and checkpointUpstream* entries describe the legacy
// Qualtrics writer; they stay at these values under the S3 writer too, because
// changing them would re-hash every issued session's configuration.
export const V2_RUNTIME_POLICY = Object.freeze({
	protocolVersion: V2_PROTOCOL_VERSION,
	sessionTtlSeconds: SESSION_TTL_SECONDS,
	checkpointHandleTtlSeconds: CHECKPOINT_HANDLE_TTL_SECONDS,
	maxClockSkewSeconds: MAX_CLOCK_SKEW_SECONDS,
	maxSessionRequestBytes: MAX_SESSION_REQUEST_BYTES,
	maxTurns: MAX_TURNS,
	maxHistoryMessages: MAX_HISTORY_MESSAGES,
	maxSnapshotMessages: MAX_SNAPSHOT_MESSAGES,
	maxCaptureErrors: MAX_CAPTURE_ERRORS,
	maxUserCodePoints: MAX_USER_CODE_POINTS,
	maxAssistantCodePoints: MAX_ASSISTANT_CODE_POINTS,
	maxChatRequestBytes: MAX_CHAT_REQUEST_BYTES,
	maxContextUtf8Bytes: MAX_CONTEXT_UTF8_BYTES,
	maxTranscriptUtf16CodeUnits: MAX_TRANSCRIPT_UTF16_CODE_UNITS,
	maxTranscriptUtf8Bytes: MAX_TRANSCRIPT_UTF8_BYTES,
	maxCheckpointRequestBytes: MAX_CHECKPOINT_REQUEST_BYTES,
	checkpointChunkSize: CHECKPOINT_CHUNK_SIZE,
	checkpointChunkCount: CHECKPOINT_CHUNK_COUNT,
	providerFirstByteTimeoutMs: OPENROUTER_FIRST_BYTE_TIMEOUT_MS,
	providerStreamIdleTimeoutMs: OPENROUTER_STREAM_IDLE_TIMEOUT_MS,
	providerHardTimeoutMs: OPENROUTER_HARD_TIMEOUT_MS,
	providerMaxAttempts: OPENROUTER_MAX_ATTEMPTS,
	providerMaxRetryAfterMs: OPENROUTER_MAX_RETRY_AFTER_MS,
	providerDefaultRetryDelayMs: OPENROUTER_DEFAULT_RETRY_DELAY_MS,
	providerRetryableStatusCodes: OPENROUTER_RETRYABLE_STATUS_CODES,
	maxProviderSseEventChars: MAX_PROVIDER_SSE_EVENT_CHARS,
	checkpointUpstreamTimeoutMs: CHECKPOINT_UPSTREAM_TIMEOUT_MS,
	checkpointUpstreamMaxAttempts: 1
});
