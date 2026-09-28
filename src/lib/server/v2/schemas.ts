import { z } from 'zod';
import {
	MAX_ASSISTANT_CODE_POINTS,
	MAX_CAPTURE_ERRORS,
	MAX_HISTORY_MESSAGES,
	MAX_SNAPSHOT_MESSAGES,
	MAX_TURNS,
	MAX_TRANSCRIPT_UTF16_CODE_UNITS,
	MAX_USER_CODE_POINTS,
	V2_PROTOCOL_VERSION
} from './limits';
import { CONDITIONS } from './tokens';

const uuid = z.string().uuid();
const boundedCodePoints = (max: number, label: string) =>
	z
		.string()
		.min(1, `${label} cannot be empty`)
		.refine((value) => Array.from(value).length <= max, `${label} is too long`);

export const SessionRequestSchema = z
	.object({
		v: z.literal(V2_PROTOCOL_VERSION),
		chatSessionKey: uuid,
		attemptNonce: uuid,
		resumeConfig: z
			.object({
				configVersion: z.string().min(1).max(96),
				configHash: z.string().regex(/^[a-f0-9]{64}$/)
			})
			.strict()
			.optional(),
		// The survey's bound serverConfigId. Honored for NEW sessions only when
		// that revision is on the server's preview-preserved allowlist (partner
		// preview surveys must keep working across deployments); otherwise the
		// active revision is served and the survey-side gate fails visibly.
		preferredConfigVersion: z.string().min(1).max(96).optional()
	})
	.strict();

const HistoryMessageSchema = z.discriminatedUnion('role', [
	z
		.object({
			id: uuid,
			role: z.literal('user'),
			content: boundedCodePoints(MAX_USER_CODE_POINTS, 'User history message')
		})
		.strict(),
	z
		.object({
			id: uuid,
			role: z.literal('assistant'),
			content: boundedCodePoints(MAX_ASSISTANT_CODE_POINTS, 'Assistant history message')
		})
		.strict()
]);

const isoDate = z.string().datetime({ offset: true });
const SnapshotMessageSchema = z
	.object({
		id: uuid,
		turnId: uuid.optional(),
		role: z.enum(['user', 'assistant']),
		content: z.string(),
		createdAtISO: isoDate,
		isInitial: z.boolean(),
		completionStatus: z.enum([
			'complete',
			'streaming',
			'incomplete',
			'superseded',
			'skipped',
			'capped'
		]),
		excludedFromModel: z.boolean(),
		failureReason: z.string().max(100).optional()
	})
	.strict()
	.superRefine((message, context) => {
		const codePoints = Array.from(message.content).length;
		const limit = message.role === 'user' ? MAX_USER_CODE_POINTS : MAX_ASSISTANT_CODE_POINTS;
		if ((message.role === 'user' && codePoints === 0) || codePoints > limit) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['content'],
				message: `${message.role} message content is invalid`
			});
		}
		if (message.isInitial && message.role !== 'assistant') {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['isInitial'],
				message: 'Only assistant messages may be initial messages'
			});
		}
		if (!message.isInitial && !message.turnId) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['turnId'],
				message: 'Non-initial messages require a turn ID'
			});
		}
	});

const SnapshotCountersSchema = z
	.object({
		totalMessages: z.number().int().nonnegative(),
		initialMessages: z.number().int().nonnegative(),
		userMessages: z.number().int().nonnegative(),
		assistantMessages: z.number().int().nonnegative(),
		completeAssistantMessages: z.number().int().nonnegative(),
		incompleteAssistantMessages: z.number().int().nonnegative(),
		totalContentCodePoints: z.number().int().nonnegative(),
		serializedUtf16CodeUnits: z.number().int().nonnegative(),
		serializedUtf8Bytes: z.number().int().nonnegative()
	})
	.strict();

const TranscriptSnapshotSchema = z
	.object({
		schemaVersion: z.literal(V2_PROTOCOL_VERSION),
		snapshotSequence: z.number().int().min(0).max(1_000_000),
		condition: z.enum(CONDITIONS),
		chatSessionKey: uuid,
		configVersion: z.string().min(1).max(96),
		configHash: z.string().regex(/^[a-f0-9]{64}$/),
		state: z.enum(['active', 'interrupted', 'completed', 'capture_error']),
		createdAtISO: isoDate,
		updatedAtISO: isoDate,
		chatEndISO: isoDate.nullable(),
		messages: z.array(SnapshotMessageSchema).max(MAX_SNAPSHOT_MESSAGES),
		counters: SnapshotCountersSchema,
		parent: z
			.object({
				lastAcknowledgedRevision: z.number().int().nonnegative(),
				syncCount: z.number().int().nonnegative()
			})
			.strict(),
		checkpoint: z
			.object({
				hasHandle: z.boolean(),
				lastAcknowledgedRevision: z.number().int().nonnegative()
			})
			.strict(),
		captureErrors: z
			.array(
				z
					.object({
						atISO: isoDate,
						stage: z.enum(['storage', 'parent', 'checkpoint', 'transcript']),
						code: z.string().min(1).max(100)
					})
					.strict()
			)
			.max(MAX_CAPTURE_ERRORS)
	})
	.strict();

export const ChatRequestSchema = z
	.object({
		v: z.literal(V2_PROTOCOL_VERSION),
		sequence: z.number().int().min(1).max(MAX_TURNS),
		history: z.array(HistoryMessageSchema).max(MAX_HISTORY_MESSAGES),
		historyTag: z.string().min(1).max(8_192),
		turn: z
			.object({
				id: uuid,
				userMessage: boundedCodePoints(MAX_USER_CODE_POINTS, 'User message')
			})
			.strict()
	})
	.strict()
	.superRefine((value, context) => {
		const expectedMessages = (value.sequence - 1) * 2;
		if (value.history.length !== expectedMessages) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['history'],
				message: `History must contain exactly ${expectedMessages} messages for sequence ${value.sequence}`
			});
		}
		const ids = new Set<string>();
		for (let index = 0; index < value.history.length; index += 1) {
			const message = value.history[index];
			const expectedRole = index % 2 === 0 ? 'user' : 'assistant';
			if (message.role !== expectedRole) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['history', index, 'role'],
					message: `History must alternate user and assistant messages`
				});
			}
			if (ids.has(message.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['history', index, 'id'],
					message: 'Message IDs must be unique'
				});
			}
			ids.add(message.id);
		}
		if (ids.has(value.turn.id)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['turn', 'id'],
				message: 'Turn ID has already appeared in history'
			});
		}
	});

export const CheckpointRequestSchema = z
	.object({
		v: z.literal(V2_PROTOCOL_VERSION),
		createOperationId: uuid,
		snapshotSequence: z.number().int().min(0).max(1_000_000),
		state: z.enum(['active', 'interrupted', 'completed', 'capture_error']),
		reasonHint: z.string().max(100).optional(),
		transcriptJson: z.string().max(MAX_TRANSCRIPT_UTF16_CODE_UNITS),
		checkpointHandle: z.string().min(1).max(8_192).optional()
	})
	.strict();

export type SessionRequest = z.infer<typeof SessionRequestSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type CheckpointRequest = z.infer<typeof CheckpointRequestSchema>;
export type ChatHistoryMessage = z.infer<typeof HistoryMessageSchema>;

export function validateTranscriptSnapshot(
	transcriptJson: string,
	expected: {
		sessionKey: string;
		condition: (typeof CONDITIONS)[number];
		configVersion: string;
		configHash: string;
		snapshotSequence: number;
		state: 'active' | 'interrupted' | 'completed' | 'capture_error';
	}
): Record<string, unknown> {
	let snapshot: unknown;
	try {
		snapshot = JSON.parse(transcriptJson);
	} catch {
		throw new Error('transcriptJson must contain one complete JSON object');
	}
	if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
		throw new Error('transcriptJson must contain one complete JSON object');
	}
	const parsed = TranscriptSnapshotSchema.safeParse(snapshot);
	if (!parsed.success) {
		throw new Error(parsed.error.issues[0]?.message ?? 'Transcript does not match the v2 schema');
	}
	const object = parsed.data;
	const assertedValues: Array<[string, unknown, string | number]> = [
		['chatSessionKey', object.chatSessionKey, expected.sessionKey],
		['condition', object.condition, expected.condition],
		['configVersion', object.configVersion, expected.configVersion],
		['configHash', object.configHash, expected.configHash],
		['snapshotSequence', object.snapshotSequence, expected.snapshotSequence],
		['state', object.state, expected.state]
	];
	for (const [name, supplied, wanted] of assertedValues) {
		if (supplied !== wanted) {
			throw new Error(`${name} does not match the signed session`);
		}
	}
	const messageIds = new Set<string>();
	for (const message of object.messages) {
		if (messageIds.has(message.id)) throw new Error('Transcript message IDs must be unique');
		messageIds.add(message.id);
	}
	const counters = {
		totalMessages: object.messages.length,
		initialMessages: object.messages.filter((message) => message.isInitial).length,
		userMessages: object.messages.filter((message) => message.role === 'user' && !message.isInitial).length,
		assistantMessages: object.messages.filter((message) => message.role === 'assistant' && !message.isInitial).length,
		completeAssistantMessages: object.messages.filter(
			(message) => message.role === 'assistant' && ['complete', 'capped'].includes(message.completionStatus)
		).length,
		incompleteAssistantMessages: object.messages.filter(
			(message) => message.role === 'assistant' && !['complete', 'capped'].includes(message.completionStatus)
		).length,
		totalContentCodePoints: object.messages.reduce(
			(total, message) => total + Array.from(message.content).length,
			0
		)
	};
	for (const [name, wanted] of Object.entries(counters)) {
		if (object.counters[name as keyof typeof counters] !== wanted) {
			throw new Error(`Transcript counter ${name} is inconsistent`);
		}
	}
	const utf8Bytes = new TextEncoder().encode(transcriptJson).byteLength;
	if (
		object.counters.serializedUtf16CodeUnits !== transcriptJson.length ||
		object.counters.serializedUtf8Bytes !== utf8Bytes
	) {
		throw new Error('Transcript serialized-length counters are inconsistent');
	}
	const stack: unknown[] = [object];
	let visited = 0;
	while (stack.length > 0) {
		const item = stack.pop();
		visited += 1;
		if (visited > 20_000) throw new Error('Transcript structure is too complex');
		if (Array.isArray(item)) {
			for (const child of item) stack.push(child);
		} else if (item && typeof item === 'object') {
			for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
				const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
				if (
					[
						'patientid',
						'sessiontoken',
						'checkpointhandle',
						'attemptnonce',
						'apikey',
						'apikeyencrypted',
						'systemprompt'
					].includes(normalized)
				) {
					throw new Error(`${key} must not be included in checkpoint data`);
				}
				stack.push(child);
			}
		}
	}
	return object as unknown as Record<string, unknown>;
}
