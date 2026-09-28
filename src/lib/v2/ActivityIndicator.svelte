<script lang="ts">
	export let label = "Preparing an answer…";
	export let showLabel = true;
</script>

<div class="activity-indicator" role="status" aria-label={showLabel ? undefined : label}>
	<span class="activity-track" aria-hidden="true"><span></span></span>
	{#if showLabel}<span class="activity-label">{label}</span>{/if}
</div>

<style>
	.activity-indicator {
		align-items: center;
		color: var(--vp-muted-text);
		display: inline-flex;
		font-size: 0.88rem;
		gap: 0.65rem;
		min-height: 1.35rem;
	}
	.activity-track {
		background: var(--vp-progress-track);
		border-radius: 9999px;
		display: block;
		height: 3px;
		overflow: hidden;
		width: 2.5rem;
	}
	.activity-track > span {
		animation: activity-glide 1.35s cubic-bezier(0.45, 0, 0.25, 1) infinite;
		background: var(--vp-progress-indicator);
		border-radius: inherit;
		display: block;
		height: 100%;
		transform: translateX(-120%);
		width: 45%;
	}
	.activity-label {
		line-height: 1.35;
	}
	@keyframes activity-glide {
		0% { opacity: 0.45; transform: translateX(-120%); }
		45%, 55% { opacity: 0.95; }
		100% { opacity: 0.45; transform: translateX(245%); }
	}
	@media (prefers-reduced-motion: reduce) {
		.activity-track > span {
			animation: none;
			opacity: 0.72;
			transform: translateX(62%);
		}
	}
</style>
