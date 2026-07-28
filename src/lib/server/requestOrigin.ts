import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

// Shared request-origin gate for API endpoints. Browsers attach an Origin
// header to every POST; legitimate traffic comes from this app's own pages,
// so the origin must match the deployment itself — plus any extra origins in
// the ALLOWED_REQUEST_ORIGINS env var (comma-separated). Requests with
// neither Origin nor Referer (curl, scripts) are rejected outside dev mode.
// This raises the bar (blocks cross-site browser calls and naive scripts);
// a non-browser client can still forge headers, so per-key spend limits and
// provider-side guardrails remain the backstop.
export function isAllowedRequestOrigin(request: Request, requestUrl: URL): boolean {
    if (dev) return true; // local development

    const extraAllowed = new Set(
        (env.ALLOWED_REQUEST_ORIGINS ?? '')
            .split(',')
            .map((s) => s.trim().replace(/\/+$/, ''))
            .filter(Boolean)
    );

    const headerToOrigin = (value: string | null): string | null => {
        if (!value) return null;
        try {
            return new URL(value).origin; // Referer carries a full URL; reduce to origin
        } catch {
            return null;
        }
    };

    const origin = headerToOrigin(request.headers.get('origin'))
        ?? headerToOrigin(request.headers.get('referer'));
    if (!origin) return false;

    return origin === requestUrl.origin || extraAllowed.has(origin);
}
