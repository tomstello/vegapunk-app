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
    // Normalize aggressively: dashboard pastes arrive with stray whitespace,
    // and datacenter is often pasted as a hostname or URL. Accept "yul1",
    // "yul1.qualtrics.com", or "https://yul1.qualtrics.com/..." equally.
    const token = (env.QUALTRICS_API_TOKEN ?? '').trim();
    const datacenter = (env.QUALTRICS_DATACENTER ?? '')
        .trim()
        .replace(/^https?:\/\//, '')
        .split('/')[0]
        .split('.')[0];
    const surveyId = (env.QUALTRICS_CHECKPOINT_SURVEY_ID ?? '').trim();
    if (!token || !datacenter || !surveyId) return null;
    if (/[^\x21-\x7e]/.test(token)) return { invalid: 'bad_token_value' as const };
    if (!/^[A-Za-z0-9-]+$/.test(datacenter)) return { invalid: 'bad_datacenter' as const };
    if (!/^SV_[A-Za-z0-9]+$/.test(surveyId)) return { invalid: 'bad_survey_id' as const };
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

// 204s are deliberately indistinguishable to the chat client, but the
// x-checkpoint header names the branch for operators probing the endpoint.
const silent = (branch: string) =>
    new Response(null, { status: 204, headers: { 'x-checkpoint': branch } });

export const POST: RequestHandler = (async ({ request, url }): Promise<Response> => {
    try {
        if (!isAllowedRequestOrigin(request, url)) {
            return new Response(null, { status: 403 });
        }
        const config = qualtricsConfig();
        if (!config) {
            return silent('disabled'); // env vars not (fully) configured
        }
        const invalidReason = (config as { invalid?: string }).invalid;
        if (invalidReason) {
            logger.warn(`checkpoint: invalid config (${invalidReason})`);
            return silent(invalidReason);
        }
        if (!('base' in config)) return silent('disabled'); // type guard; unreachable

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) {
            logger.warn(`checkpoint: oversized payload (${raw.length} bytes) rejected`);
            return silent('oversized');
        }
        const body = JSON.parse(raw) as {
            sessionKey?: string;
            checkpointResponseId?: string; // present after the first successful checkpoint
            session?: Record<string, unknown>; // responseId/condition/etc from the survey
            transcript?: unknown; // messages + messageInfo + chatParams (key already redacted client-side)
            reasonHint?: string;
        };

        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.slice(0, 64) : '';
        if (!sessionKey) return silent('no_session_key');

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
            let updateRes: Response | null = null;
            try {
                updateRes = await fetch(
                `${config.base}/responses/${body.checkpointResponseId}`,
                {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify({ surveyId: config.surveyId, embeddedData }),
                }
                );
            } catch (e) {
                logger.warn(`checkpoint: update threw (${(e as Error)?.message}); falling back to create`);
            }
            if (updateRes && updateRes.ok) {
                return new Response(JSON.stringify({ checkpointResponseId: body.checkpointResponseId }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'x-checkpoint': 'ok_update' },
                });
            }
            if (updateRes) logger.warn(`checkpoint: update failed (${updateRes.status}); falling back to create`);
        }

        // Verified against the live API (2026-07-28): embedded-data fields go
        // DIRECTLY inside `values` — a nested `embeddedData` object is
        // silently dropped by the create endpoint. (The update endpoint, by
        // contrast, takes a top-level `embeddedData` object. Asymmetric, but
        // both shapes below are empirically confirmed.)
        let createRes: Response;
        try {
            createRes = await fetch(`${config.base}/surveys/${config.surveyId}/responses`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ values: { ...embeddedData, tsFirst: new Date().toISOString() } }),
            });
        } catch (e) {
            logger.warn(`checkpoint: create threw (${(e as Error)?.message})`);
            return silent('create_unreachable');
        }
        if (!createRes.ok) {
            logger.warn(`checkpoint: create failed (${createRes.status})`);
            return silent(`create_failed_${createRes.status}`);
        }
        const created = (await createRes.json()) as any;
        const newId: string = created?.result?.responseId ?? created?.result?.id ?? '';
        return new Response(JSON.stringify({ checkpointResponseId: newId }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'x-checkpoint': 'ok_create' },
        });
    } catch (error) {
        logger.error(error, 'checkpoint: unexpected error (swallowed)');
        return silent('error');
    }
}) satisfies RequestHandler;
