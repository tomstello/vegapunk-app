export const STREAM_PRESENTATION_FRAME_MS = 40;
export const STREAM_PRESENTATION_MAX_LAG_MS = 160;
const SMALL_CHUNK_CODE_POINTS = 24;
const MIN_FRAME_CODE_POINTS = 12;

export interface PresentationFrame {
	visible: string;
	pending: string;
}

/**
 * Selects one Unicode-safe display frame from canonical text that has already
 * been captured. Large, bursty provider chunks are spread over at most four
 * quiet paints; small chunks appear together rather than as a typewriter.
 */
export function takePresentationFrame(pending: string, ageMs: number): PresentationFrame {
	const points = Array.from(pending);
	if (points.length === 0) return { visible: "", pending: "" };
	if (points.length <= SMALL_CHUNK_CODE_POINTS || ageMs >= STREAM_PRESENTATION_MAX_LAG_MS) {
		return { visible: pending, pending: "" };
	}
	const remainingFrames = Math.max(
		1,
		Math.ceil(
			(STREAM_PRESENTATION_MAX_LAG_MS - Math.max(0, ageMs)) /
				STREAM_PRESENTATION_FRAME_MS,
		),
	);
	const visibleCount = Math.min(
		points.length,
		Math.max(MIN_FRAME_CODE_POINTS, Math.ceil(points.length / remainingFrames)),
	);
	return {
		visible: points.slice(0, visibleCount).join(""),
		pending: points.slice(visibleCount).join(""),
	};
}
