import { MAX_CHECKPOINT_BODY_BYTES, utf8Length } from "./constants";
import type {
	CheckpointRequest,
	CheckpointResponse,
	V2PersistedState,
} from "./types";
import type { SerializedSnapshot } from "./snapshot";

interface CheckpointJob {
	serialized: SerializedSnapshot;
	reasonHint: string;
	preferKeepalive: boolean;
}

interface WorkerOptions {
	getState: () => V2PersistedState;
	getToken: () => string;
	initialRecoveryDelayMs?: number;
	ambiguousRecoveryDelayMs?: number;
	onLeaseStarted: (snapshotSequence: number, startedAtISO: string) => void;
	onLeaseSettled: (snapshotSequence: number) => void;
	onAcknowledged: (response: CheckpointResponse) => void;
	onFailure: (code: string) => void;
}

// The server's 20-second checkpoint-store clock (Qualtrics or S3; see
// CHECKPOINT_UPSTREAM_TIMEOUT_MS) begins only after it has received up to
// 400 KB from the browser. A long wall-clock margin is safer on cellular:
// aborting an otherwise successful create can manufacture an ambiguous row.
export const CHECKPOINT_CLIENT_TIMEOUT_MS = 75_000;
// A recovered/ambiguous lease is a heuristic, not a lock. The 120-second
// window covers the current 75-second browser request deadline plus the
// server's 20-second store deadline (up to two attempts on S3) with margin.
// Duplicate tabs and a platform request that outlives these bounds still
// require recovery merging.
export const CHECKPOINT_LEASE_GUARD_WINDOW_MS = 120_000;
const MAX_KEEPALIVE_BYTES = 60_000;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkpointRecoveryDelayMs(
	startedAtISO: string | null,
	nowMs = Date.now(),
): number {
	if (!startedAtISO) return 0;
	const startedAt = Date.parse(startedAtISO);
	const age = nowMs - startedAt;
	return Number.isFinite(startedAt) && age >= 0 && age < CHECKPOINT_LEASE_GUARD_WINDOW_MS
		? CHECKPOINT_LEASE_GUARD_WINDOW_MS - age
		: 0;
}

export class CheckpointWorker {
	private pending: CheckpointJob | null = null;
	private running = false;
	private stopped = false;
	private recoveryDelayConsumed = false;
	private recoveryDeadlineMs: number | null;

	constructor(private readonly options: WorkerOptions) {
		const initialDelay = Math.max(0, options.initialRecoveryDelayMs ?? 0);
		this.recoveryDeadlineMs = initialDelay > 0 ? Date.now() + initialDelay : null;
	}

	enqueue(
		serialized: SerializedSnapshot,
		reasonHint: string,
		preferKeepalive = false,
	): void {
		if (this.stopped) return;
		this.pending = { serialized, reasonHint, preferKeepalive };
		if (!this.running) void this.drain();
	}

	stop(): void {
		this.stopped = true;
		this.pending = null;
	}

	private async drain(): Promise<void> {
		this.running = true;
		try {
			if (!this.recoveryDelayConsumed) {
				this.recoveryDelayConsumed = true;
				const delay = this.recoveryDeadlineMs === null
					? 0
					: Math.max(0, this.recoveryDeadlineMs - Date.now());
				this.recoveryDeadlineMs = null;
				if (delay > 0) {
					await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
				}
			}
			while (!this.stopped && this.pending) {
				const job = this.pending;
				this.pending = null;
				const succeeded = await this.send(job);
				if (!succeeded) {
					// A job that arrived while the failed request was in flight is not
					// a genuinely later recovery event. Drop it to avoid retry storms
					// and, for a create, an immediate physical duplicate.
					this.pending = null;
					break;
				}
			}
		} finally {
			this.running = false;
			if (!this.stopped && this.pending) void this.drain();
		}
	}

	private async send(job: CheckpointJob): Promise<boolean> {
		// State (especially the signed handle) is read only after the previous
		// request settles. This is what prevents two ordinary create requests.
		const state = this.options.getState();
		const request: CheckpointRequest = {
			v: 2,
			createOperationId: state.createOperationId,
			snapshotSequence: job.serialized.snapshot.snapshotSequence,
			state: job.serialized.snapshot.state,
			reasonHint: job.reasonHint.slice(0, 64),
			transcriptJson: job.serialized.json,
			...(state.checkpointHandle
				? { checkpointHandle: state.checkpointHandle }
				: {}),
		};
		const body = JSON.stringify(request);
		const bodyBytes = utf8Length(body);
		if (bodyBytes > MAX_CHECKPOINT_BODY_BYTES) {
			this.options.onFailure("checkpoint_body_too_large");
			return false;
		}

		const controller = new AbortController();
		const timer = window.setTimeout(() => controller.abort(), CHECKPOINT_CLIENT_TIMEOUT_MS);
		const leaseStartedAtISO = new Date().toISOString();
		this.options.onLeaseStarted(request.snapshotSequence, leaseStartedAtISO);
		// A lease is settled only by a fully validated acknowledgement or a
		// demonstrably non-mutating rejection. A 5xx/timeout or malformed 2xx may
		// follow a successful Qualtrics write whose usable handle was lost.
		let settleLease = false;
		try {
			const response = await fetch("/api/v2/checkpoint", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.options.getToken()}`,
				},
				body,
				keepalive: job.preferKeepalive && bodyBytes <= MAX_KEEPALIVE_BYTES,
				signal: controller.signal,
			});
			if (!response.ok) {
				let errorCode = `checkpoint_http_${response.status}`;
				let explicitlyAmbiguous = false;
				try {
					const errorText = await response.text();
					if (errorText.length <= 12_000) {
						const parsedError: unknown = JSON.parse(errorText);
						if (isRecord(parsedError) && isRecord(parsedError.error)) {
							if (typeof parsedError.error.code === "string") {
								errorCode = parsedError.error.code.slice(0, 100);
							}
							explicitlyAmbiguous = parsedError.error.ambiguousCreate === true ||
								parsedError.error.code === "ambiguous_create" ||
								parsedError.error.code === "checkpoint_update_unreachable";
						}
					}
				} catch {
					// Status-based classification below remains conservative.
				}
				const ambiguous = explicitlyAmbiguous || response.status === 408 || response.status >= 500;
				if (ambiguous) {
					this.armAmbiguousRecovery();
					this.options.onFailure(
						state.checkpointHandle
							? "checkpoint_update_ambiguous"
							: "checkpoint_create_ambiguous",
					);
				} else {
					settleLease = true;
					this.options.onFailure(errorCode);
				}
				return false;
			}
			const responseText = await response.text();
			if (responseText.length > 12_000) {
				this.armAmbiguousRecovery();
				this.options.onFailure("checkpoint_response_too_large");
				return false;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(responseText);
			} catch {
				this.armAmbiguousRecovery();
				this.options.onFailure("checkpoint_invalid_json");
				return false;
			}
			if (
				!isRecord(parsed) ||
				parsed.v !== 2 ||
				typeof parsed.checkpointHandle !== "string" ||
				parsed.checkpointHandle.length < 20 ||
				parsed.checkpointHandle.length > 4_096 ||
				parsed.acknowledgedSequence !== request.snapshotSequence ||
				typeof parsed.checksum !== "string" ||
				!CHECKSUM_PATTERN.test(parsed.checksum)
			) {
				this.armAmbiguousRecovery();
				this.options.onFailure("checkpoint_invalid_schema");
				return false;
			}
			const expectedChecksum = await sha256Hex(job.serialized.json);
			if (parsed.checksum.toLowerCase() !== expectedChecksum) {
				this.armAmbiguousRecovery();
				this.options.onFailure("checkpoint_checksum_mismatch");
				return false;
			}
			this.options.onAcknowledged({
				v: 2,
				checkpointHandle: parsed.checkpointHandle,
				acknowledgedSequence: parsed.acknowledgedSequence,
				checksum: parsed.checksum,
			});
			settleLease = true;
			return true;
		} catch {
			// No immediate retry. A later cumulative snapshot is the recovery path.
			// Keep the persisted lease: the server may continue after a browser-side
			// network loss. A genuinely later enqueue waits past that upstream
			// window before reconciling with its newest cumulative snapshot.
			this.armAmbiguousRecovery();
			this.options.onFailure(
				state.checkpointHandle
					? "checkpoint_update_ambiguous"
					: "checkpoint_create_ambiguous",
			);
			return false;
		} finally {
			window.clearTimeout(timer);
			if (settleLease) {
				this.options.onLeaseSettled(request.snapshotSequence);
			}
		}
	}

	private armAmbiguousRecovery(): void {
		const delay = Math.max(
			0,
			this.options.ambiguousRecoveryDelayMs ?? CHECKPOINT_LEASE_GUARD_WINDOW_MS,
		);
		this.recoveryDeadlineMs = delay > 0 ? Date.now() + delay : null;
		this.recoveryDelayConsumed = false;
	}
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
