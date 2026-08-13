export const SCROLL_BOTTOM_THRESHOLD = 80;

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
	if (distanceFromBottom < threshold) return { following: true, showButton: false, pinToBottom: false };
	if (following) return { following: true, showButton: false, pinToBottom: true };
	return { following: false, showButton: true, pinToBottom: false };
}
