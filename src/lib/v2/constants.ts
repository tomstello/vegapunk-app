import type { PublicUiConfig, StudyCondition } from "./types";

export const V2_SCHEMA_VERSION = 2 as const;
export const MAX_TURNS = 35;
// Qualtrics validates the same maximum before it writes primary hidden fields.
export const MAX_SNAPSHOT_MESSAGES = 200;
// One original answer plus two participant-initiated retries bounds transcript
// growth when the provider fails quickly and repeatedly.
export const MAX_ASSISTANT_ATTEMPTS_PER_TURN = 3;
export const MAX_USER_CODE_POINTS = 1_500;
export const MAX_ASSISTANT_CODE_POINTS = 16_000;
export const MAX_TRANSCRIPT_UTF16 = 240_000;
export const MAX_TRANSCRIPT_UTF8 = 280_000;
export const MAX_CHECKPOINT_BODY_BYTES = 400_000;
export const MAX_CAPTURE_ERRORS = 20;
export const LOCAL_STREAM_PERSIST_MS = 500;
export const PARENT_HANDSHAKE_TIMEOUT_MS = 12_000;

export const CONFIG_VERSIONS: Record<StudyCondition, string> = {
	flu: "albertsons-2026-flu-v8",
	covid: "albertsons-2026-covid-v8",
	combo: "albertsons-2026-combo-v8",
};

export const DEFAULT_UI: PublicUiConfig = {
	themeId: "neutral-v1",
	headerTitle: "Vaccine Questions",
	headerSubtitle: "",
	privacyNote:
		"Please do not share names, contact information, or other personal details in the chat.",
	placeholderInputText: "Write your vaccine question",
	suggestedQuestions: [],
	endChatText: "End chat",
	maxUserMessages: MAX_TURNS,
};

export function countCodePoints(value: string): number {
	return Array.from(value).length;
}

export function takeCodePoints(value: string, maximum: number): string {
	if (maximum <= 0) return "";
	const points = Array.from(value);
	return points.length <= maximum ? value : points.slice(0, maximum).join("");
}

export function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function newUuid(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
