import { env as publicEnvironment } from "$env/dynamic/public";
import { parseQualtricsParentOrigins } from "$lib/qualtricsOrigins.js";
import { PARENT_HANDSHAKE_TIMEOUT_MS, newUuid } from "./constants";
import type {
	ParentInitMessage,
	ParentMessage,
	StudyCondition,
	TerminalReason,
	V2Snapshot,
} from "./types";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_REASONS = new Set<TerminalReason>([
	"completed",
	"participant_end",
	"inactivity",
	"never_engaged",
	"hard_cap",
	"init_failure",
]);

type AckHandler = (
	acknowledgedSnapshotSequence: number,
	isEndAck: boolean,
) => void;
type FlushHandler = (reason: string) => void;
type PersistHandler = (reason: string) => void;

function configuredParentOrigins(): Set<string> {
	return new Set(
		parseQualtricsParentOrigins(
			publicEnvironment.PUBLIC_QUALTRICS_PARENT_ORIGINS ?? "",
		),
	);
}

function isDevelopmentOrigin(origin: string): boolean {
	if (!import.meta.env.DEV) return false;
	try {
		const parsed = new URL(origin);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			(parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
		);
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

function isParentInit(
	value: unknown,
	condition: StudyCondition,
	helloNonce: string,
	eventOrigin: string,
): value is ParentInitMessage {
	if (!isRecord(value)) return false;
	return (
		hasOnlyKeys(value, [
			"v", "type", "condition", "helloNonce", "nonce", "sessionKey",
			"attemptNonce", "expectedConfigVersion", "parentOrigin", "sequence",
			"checkpointHandle", "createOperationId", "historyTag", "historySequence",
			"checkpointInFlightSequence", "checkpointInFlightStartedAtISO",
			"terminalReason", "lastSnapshot",
		]) &&
		value.v === 2 &&
		value.type === "qualtrics:init" &&
		value.condition === condition &&
		value.helloNonce === helloNonce &&
		isUuid(value.nonce) &&
		isUuid(value.sessionKey) &&
		isUuid(value.attemptNonce) &&
		typeof value.expectedConfigVersion === "string" &&
		value.parentOrigin === eventOrigin &&
		value.sequence === 0 &&
		(value.checkpointHandle === undefined ||
			(typeof value.checkpointHandle === "string" &&
				value.checkpointHandle.length <= 4_096)) &&
		(value.createOperationId === undefined || isUuid(value.createOperationId)) &&
		((value.checkpointInFlightSequence === undefined &&
			value.checkpointInFlightStartedAtISO === undefined) ||
			(Number.isSafeInteger(value.checkpointInFlightSequence) &&
				(value.checkpointInFlightSequence as number) >= 0 &&
				typeof value.checkpointInFlightStartedAtISO === "string" &&
				Number.isFinite(Date.parse(value.checkpointInFlightStartedAtISO)))) &&
		(value.historyTag === undefined ||
			(typeof value.historyTag === "string" &&
				value.historyTag.length >= 1 &&
				value.historyTag.length <= 4_096)) &&
		(value.historySequence === undefined ||
			(Number.isSafeInteger(value.historySequence) &&
				(value.historySequence as number) >= 0 &&
				(value.historySequence as number) <= 35)) &&
		((value.historyTag === undefined && value.historySequence === undefined) ||
			(value.historyTag !== undefined && value.historySequence !== undefined)) &&
		(value.terminalReason === undefined ||
			(typeof value.terminalReason === "string" &&
				TERMINAL_REASONS.has(value.terminalReason as TerminalReason)))
	);
}

function isParentMessage(
	value: unknown,
	condition: StudyCondition,
	sessionKey: string,
	nonce: string,
): value is ParentMessage {
	if (!isRecord(value)) return false;
	const hasReason = value.type === "qualtrics:flush" || value.type === "qualtrics:persist";
	const allowed = hasReason
		? ["v", "type", "condition", "sessionKey", "nonce", "sequence", "reason"]
		: ["v", "type", "condition", "sessionKey", "nonce", "sequence", "acknowledgedSnapshotSequence"];
	if (
		!hasOnlyKeys(value, allowed) ||
		value.v !== 2 ||
		value.condition !== condition ||
		value.sessionKey !== sessionKey ||
		value.nonce !== nonce ||
		!Number.isSafeInteger(value.sequence) ||
		(value.sequence as number) < 1
	) {
		return false;
	}
	if (hasReason) {
		return typeof value.reason === "string" && value.reason.length >= 1 && value.reason.length <= 100;
	}
	if (value.type === "qualtrics:ack" || value.type === "qualtrics:end-ack") {
		return (
			Number.isSafeInteger(value.acknowledgedSnapshotSequence) &&
			(value.acknowledgedSnapshotSequence as number) >= 0
		);
	}
	return false;
}

export class ParentBridge {
	readonly helloNonce = newUuid();
	private readonly origins = configuredParentOrigins();
	private parentOrigin = "";
	private nonce = "";
	private sessionKey = "";
	private outboundSequence = 0;
	private lastInboundSequence = 0;
	private connected = false;
	private ackHandler: AckHandler | null = null;
	private flushHandler: FlushHandler | null = null;
	private persistHandler: PersistHandler | null = null;
	private messageHandler: ((event: MessageEvent) => void) | null = null;

	constructor(private readonly condition: StudyCondition) {}

	onAck(handler: AckHandler): void {
		this.ackHandler = handler;
	}

	onFlush(handler: FlushHandler): void {
		this.flushHandler = handler;
	}

	onPersist(handler: PersistHandler): void {
		this.persistHandler = handler;
	}

	async connect(): Promise<ParentInitMessage> {
		if (window.parent === window) {
			throw new Error("parent_required");
		}

		return new Promise<ParentInitMessage>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error, init?: ParentInitMessage) => {
				if (settled) return;
				settled = true;
				window.clearInterval(helloTimer);
				window.clearTimeout(timeoutTimer);
				if (error) {
					this.destroy();
					reject(error);
				} else if (init) {
					resolve(init);
				}
			};

			this.messageHandler = (event: MessageEvent) => {
				if (event.source !== window.parent) return;
				if (!this.origins.has(event.origin) && !isDevelopmentOrigin(event.origin)) {
					return;
				}
				const data: unknown = event.data;
				if (!this.connected) {
					if (!isParentInit(data, this.condition, this.helloNonce, event.origin)) {
						return;
					}
					this.parentOrigin = event.origin;
					this.nonce = data.nonce;
					this.sessionKey = data.sessionKey;
					this.lastInboundSequence = 0;
					this.connected = true;
					finish(undefined, data);
					return;
				}

				if (event.origin !== this.parentOrigin) return;
				if (!isParentMessage(data, this.condition, this.sessionKey, this.nonce)) {
					return;
				}
				if (data.sequence <= this.lastInboundSequence) return;
				this.lastInboundSequence = data.sequence;
				if (data.type === "qualtrics:flush") {
					this.flushHandler?.(data.reason.slice(0, 100));
				} else if (data.type === "qualtrics:persist") {
					this.persistHandler?.(data.reason.slice(0, 100));
				} else if (data.type === "qualtrics:ack" || data.type === "qualtrics:end-ack") {
					this.ackHandler?.(
						data.acknowledgedSnapshotSequence,
						data.type === "qualtrics:end-ack",
					);
				}
			};

			window.addEventListener("message", this.messageHandler);
			const sendHello = () => {
				window.parent.postMessage(
					{
						v: 2,
						type: "vegapunk:hello",
						condition: this.condition,
						helloNonce: this.helloNonce,
					},
					"*",
				);
			};
			const helloTimer = window.setInterval(sendHello, 750);
			const timeoutTimer = window.setTimeout(
				() => finish(new Error("parent_handshake_timeout")),
				PARENT_HANDSHAKE_TIMEOUT_MS,
			);
			sendHello();
		});
	}

	sendReady(
		configVersion: string,
		configHash: string,
		historyTag: string,
		historySequence: number,
		createOperationId: string,
	): void {
		this.send({
			type: "vegapunk:ready",
			configVersion,
			configHash,
			historyTag,
			historySequence,
			createOperationId,
		});
	}

	sendActivity(kind: "input" | "reading" | "submit" | "retry" | "end" | "appointment_click"): void {
		this.send({ type: "vegapunk:activity", kind });
	}

	sendCheckpointLease(snapshotSequence: number, startedAtISO: string | null): void {
		this.send({
			type: "vegapunk:checkpoint-lease",
			snapshotSequence,
			startedAtISO,
		});
	}

	sendSnapshot(
		snapshot: V2Snapshot,
		reason: string,
		checkpointHandle: string | null,
		historyTag: string,
		historySequence: number,
		createOperationId: string,
	): void {
		this.send({
			type: "vegapunk:snapshot",
			snapshot,
			reason: reason.slice(0, 100),
			...(checkpointHandle ? { checkpointHandle } : {}),
			historyTag,
			historySequence,
			createOperationId,
		});
	}

	sendEnd(
		snapshot: V2Snapshot,
		reason: string,
		checkpointHandle: string | null,
		historyTag: string,
		historySequence: number,
		createOperationId: string,
	): void {
		this.send({
			type: "vegapunk:end",
			snapshot,
			reason: reason.slice(0, 100),
			...(checkpointHandle ? { checkpointHandle } : {}),
			historyTag,
			historySequence,
			createOperationId,
		});
	}

	destroy(): void {
		if (this.messageHandler) {
			window.removeEventListener("message", this.messageHandler);
			this.messageHandler = null;
		}
		this.connected = false;
	}

	private send(fields: Record<string, unknown>): void {
		if (!this.connected || !this.parentOrigin) return;
		this.outboundSequence += 1;
		window.parent.postMessage(
			{
				v: 2,
				condition: this.condition,
				sessionKey: this.sessionKey,
				nonce: this.nonce,
				sequence: this.outboundSequence,
				...fields,
			},
			this.parentOrigin,
		);
	}
}
