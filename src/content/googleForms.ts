const INTENT_MAX_AGE_MS = 5 * 60_000;

const confirmationText = /(?:your response has been recorded|response submitted|ответ записан|ответ отправлен|ваш ответ|жауабыңыз жазылды|жауап жіберілді)/i;
const submitText = /^(?:submit|send|отправить|отправить форму|жіберу|жiберу)$/i;

export interface GoogleFormsIntent {
  sessionId: string;
  timestamp: number;
}

export const isGoogleFormsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'docs.google.com'
      && url.pathname.startsWith('/forms/');
  } catch {
    return false;
  }
};

export const isLikelySubmitControl = (element: Element | null): boolean => {
  if (!element) return false;
  const control = element.closest('button, input[type="submit"], [role="button"]');
  if (!control) return false;
  if (control instanceof HTMLInputElement && control.type === 'submit') return true;
  const label = `${control.getAttribute('aria-label') ?? ''} ${control.textContent ?? ''}`
    .replace(/\s+/g, ' ')
    .trim();
  return submitText.test(label);
};

export const isConfirmedGoogleFormsSubmission = (
  urlValue: string,
  bodyText: string,
  hasQuestionElements: boolean,
  hasConfirmationContainer: boolean,
): boolean => {
  if (!isGoogleFormsUrl(urlValue)) return false;
  const url = new URL(urlValue);
  const responsePath = url.pathname.includes('/formResponse');
  if (!responsePath) return false;
  return confirmationText.test(bodyText) || (hasConfirmationContainer && !hasQuestionElements);
};

export const isFreshIntent = (
  intent: GoogleFormsIntent | null,
  sessionId: string,
  now = Date.now(),
): boolean => Boolean(
  intent
  && intent.sessionId === sessionId
  && now >= intent.timestamp
  && now - intent.timestamp <= INTENT_MAX_AGE_MS,
);
