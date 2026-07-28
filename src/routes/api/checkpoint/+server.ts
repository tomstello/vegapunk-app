import { env } from '$env/dynamic/private';
import { logger } from '$lib/logger';
import { isAllowedRequestOrigin } from '$lib/server/requestOrigin';
import type { RequestHandler } from './$types';

// ============================================================================
// Transcript checkpoint relay.
//
// The chat client POSTs transcript snapshots here after each event (user
// message sent, model response finished, exit flush). This endpoint relays
// them into a dedicated Qualtrics "checkpoint" survey via the Qualtrics REST
// API — first snapshot creates the response, later snapshots update it — so
// a transcript exists server-side at Qualtrics even if the participant's
// browser is frozen or killed before the survey page ever submits.
//
// Statelessness: nothing is stored here. This is a pass-through, exactly like
// the model relay. The Qualtrics API token lives in server env only.
//
// Feature-flagged: if QUALTRICS_API_TOKEN / QUALTRICS_DATACENTER /
// QUALTRICS_CHECKPOINT_SURVEY_ID are not all set, the endpoint answers 204
// and the client carries on — checkpointing simply doesn't happen.
//
// Fail-silent contract: this endpoint must NEVER break the chat. All failures
// are logged and swallowed; the client ignores the outcome either way.
// ============================================================================

// Embedded-data values are truncated around 15KB when recorded, so transcripts
// are re-chunked here to a safe size across chunk1..chunkN fields (declared in
// the checkpoint survey's flow).
const ED_CHUNK_SIZE = 12000;
const MAX_ED_CHUNKS = 10;
const MAX_BODY_BYTES = 250_000; // transcript JSON is ~40k worst case; refuse absurd payloads

const qualtricsConfig = () => {
    const token = env.QUALTRICS_API_TOKEN;
    const datacenter = env.QUALTRICS_DATACENTER; // e.g. "ca1"
    const surveyId = env.QUALTRICS_CHECKPOINT_SURVEY_ID; // e.g. "SV_..."
    if (!token || !datacenter || !surveyId) return null;
    return { token, datacenter, surveyId, base: `https://${datacenter}.qualtrics.com/API/v3` };
};

function chunkTranscript(transcriptJson: string): Record<string, string> {
    const fields: Record<string, string> = {};
    const nChunks = Math.min(Math.ceil(transcriptJson.length / ED_CHUNK_SIZE), MAX_ED_CHUNKS);
    for (let i = 0; i < nChunks; i++) {
        fields[`chunk${i + 1}`] = transcriptJson.substring(i * ED_CHUNK_SIZE, (i + 1) * ED_CHUNK_SIZE);
    }
    fields['nChunks'] = String(nChunks);
    if (transcriptJson.length > ED_CHUNK_SIZE * MAX_ED_CHUNKS) {
        fields['chunkOverflow'] = String(transcriptJson.length);
    }
    return fields;
}

export const POST: RequestHandler = (async ({ request, url }): Promise<Response> => {
    try {
        if (!isAllowedRequestOrigin(request, url)) {
            return new Response(null, { status: 403 });
        }
        const config = qualtricsConfig();
        if (!config) {
            return new Response(null, { status: 204 }); // checkpointing disabled
        }

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) {
            logger.warn(`checkpoint: oversized payload (${raw.length} bytes) rejected`);
            return new Response(null, { status: 204 });
        }
        const body = JSON.parse(raw) as {
            sessionKey?: string;
            checkpointResponseId?: string; // present after the first successful checkpoint
            session?: Record<string, unknown>; // responseId/condition/etc from the survey
            transcript?: unknown; // messages + messageInfo + chatParams (key already redacted client-side)
            reasonHint?: string;
        };

        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.slice(0, 64) : '';
        if (!sessionKey) return new Response(null, { status: 204 });

        const transcriptJson = JSON.stringify(body.transcript ?? {});
        const embeddedData: Record<string, string> = {
            sessionKey,
            mainResponseId: String((body.session as any)?.responseId ?? '').slice(0, 64),
            condition: String((body.session as any)?.condition ?? '').slice(0, 64),
            reasonHint: String(body.reasonHint ?? '').slice(0, 32),
            tsLast: new Date().toISOString(),
            ...chunkTranscript(transcriptJson),
        };

        // Update if the client brought a response id from an earlier checkpoint;
        // otherwise create. On a failed update (e.g. deleted row), fall through
        // to create so data is never dropped on the floor.
        const headers = {
            'Content-Type': 'application/json',
            'X-API-TOKEN': config.token,
        };

        if (body.checkpointResponseId && /^R_[A-Za-z0-9]+$/.test(body.checkpointResponseId)) {
            const updateRes = await fetch(
                `${config.base}/responses/${body.checkpointResponseId}`,
                {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify({ surveyId: config.surveyId, embeddedData }),
                }
            );
            if (updateRes.ok) {
                return new Response(JSON.stringify({ checkpointResponseId: body.checkpointResponseId }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            logger.warn(`checkpoint: update failed (${updateRes.status}); falling back to create`);
        }

        const createRes = await fetch(`${config.base}/surveys/${config.surveyId}/responses`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ values: { embeddedData, tsFirst: new Date().toISOString() } }),
        });
        if (!createRes.ok) {
            logger.warn(`checkpoint: create failed (${createRes.status})`);
            return new Response(null, { status: 204 });
        }
        const created = (await createRes.json()) as any;
        const newId: string = created?.result?.responseId ?? created?.result?.id ?? '';
        return new Response(JSON.stringify({ checkpointResponseId: newId }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        logger.error(error, 'checkpoint: unexpected error (swallowed)');
        return new Response(null, { status: 204 });
    }
}) satisfies RequestHandler;
