export const SCROLL_BOTTOM_THRESHOLD = 80;
export const SCROLL_RESUME_THRESHOLD = 1;

export type ScrollFollowDecision = {
	following: boolean;
	showButton: boolean;
	pinToBottom: boolean;
};

/**
 * Keep layout-driven height changes from masquerading as an upward user scroll.
 * Explicit wheel/touch/scrollbar intent changes `following` before this runs.
 */
export function resolveScrollFollow(
	following: boolean,
	distanceFromBottom: number,
	threshold = SCROLL_BOTTOM_THRESHOLD,
): ScrollFollowDecision {
	if (!following) {
		// Once the user leaves bottom-follow, nearby layout changes and streaming
		// must not opt them back in. Resume only when they reach the actual end.
		if (distanceFromBottom <= SCROLL_RESUME_THRESHOLD) {
			return { following: true, showButton: false, pinToBottom: false };
		}
		return { following: false, showButton: true, pinToBottom: false };
	}
	if (distanceFromBottom < threshold) return { following: true, showButton: false, pinToBottom: false };
	return { following: true, showButton: false, pinToBottom: true };
}
