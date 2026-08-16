export const MAX_WEB_QUEUE_DELIVERY_ATTEMPTS = 3;
const WEB_QUEUE_RETRY_BASE_DELAY_MS = 250;

export type QueueDeliveryFailureDisposition = {
  attempts: number;
  discard: boolean;
  retryDelayMs?: number;
};

export function queueDeliveryFailureDisposition(
  previousAttempts: number,
): QueueDeliveryFailureDisposition {
  const attempts = Math.max(0, previousAttempts) + 1;
  if (attempts >= MAX_WEB_QUEUE_DELIVERY_ATTEMPTS)
    return { attempts, discard: true };
  return {
    attempts,
    discard: false,
    retryDelayMs: WEB_QUEUE_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1),
  };
}

export async function persistPreDeliveryTransition(options: {
  persist: () => Promise<void>;
  previousAttempts: number;
  publishError: (error: unknown, attempts: number, exhausted: boolean) => void;
  scheduleRetry: (delayMs: number) => void;
}): Promise<boolean> {
  try {
    await options.persist();
    return true;
  } catch (error) {
    const disposition = queueDeliveryFailureDisposition(
      options.previousAttempts,
    );
    options.publishError(error, disposition.attempts, disposition.discard);
    if (!disposition.discard) options.scheduleRetry(disposition.retryDelayMs!);
    return false;
  }
}
