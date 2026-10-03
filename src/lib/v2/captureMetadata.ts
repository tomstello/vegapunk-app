// Capture metadata is categorical, never a second free-text input channel.
// Unknown client/provider diagnostics remain available in operational logs;
// research snapshots carry a generic code instead of arbitrary error text.
const CODES = new Set([
	"client_error", "client_reload", "client_reload_before_stream",
	"client_output_cap_without_done", "chat_ended_during_stream",
	"assistant_completion_capture_failed", "assistant_failure_capture_failed",
	"session_storage_unavailable", "stored_state_preserved_as_corrupt",
	"checkpoint_handle_recovery_mismatch", "create_operation_recovery_mismatch",
	"invalid_snapshot_preserved_previous", "postmessage_failed",
	"checkpoint_body_too_large", "checkpoint_response_too_large",
	"checkpoint_invalid_json", "checkpoint_invalid_schema", "checkpoint_checksum_mismatch",
	"checkpoint_create_ambiguous", "checkpoint_update_ambiguous",
	"invalid_checkpoint_provenance", "invalid_checkpoint_metadata",
	"checkpoint_unavailable", "checkpoint_rate_limited", "checkpoint_store_throttled",
	"invalid_session", "invalid_checkpoint_handle", "stale_checkpoint",
	"checkpoint_stream_mismatch", "invalid_transcript", "transcript_too_large",
	"participant_cancelled", "first_event_timeout", "stream_idle_timeout",
	"hard_stream_timeout", "unexpected_stream_error", "stream_eof_before_done",
	"chat_network_error", "provider_error", "empty_response", "stream_interrupted",
	"upstream_eof", "missing_finish_reason", "malformed_upstream_event",
	"capped/length", "capped/content_filter", "capped/application_limit"
]);
const REASONS = new Set([
	"other", "initialized", "user_submitted", "retry_started", "assistant_completed",
	"assistant_incomplete", "answer_skipped", "checkpoint_ack", "checkpoint_capture_error",
	"completed", "participant_end", "inactivity", "never_engaged", "hard_cap", "init_failure",
	"pagehide", "visibility_hidden", "parent_flush", "parent_persist"
]);
export function captureCode(value: string): string {
	return CODES.has(value) || /^(?:chat|checkpoint|session)_http_[1-5][0-9]{2}$/.test(value)
		? value : "client_error";
}
export function captureReason(value: string): string {
	return REASONS.has(value) ? value : "other";
}
