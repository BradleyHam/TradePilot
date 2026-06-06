import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Build a Gmail compose URL that opens a pre-addressed compose window in
 * the browser's signed-in Gmail. Used by the lead Email buttons instead
 * of a raw `mailto:` — `mailto:` does nothing on desktop unless a default
 * mail handler is configured, whereas this works in any browser.
 *
 * Open the result in a new tab (target="_blank"). Subject/body are
 * optional and left blank for now; pass them later if we add reply
 * templates.
 */
export function gmailComposeUrl(
  to: string,
  opts?: { subject?: string; body?: string },
): string {
  const params = new URLSearchParams({ view: 'cm', fs: '1', to });
  if (opts?.subject) params.set('su', opts.subject);
  if (opts?.body) params.set('body', opts.body);
  return `https://mail.google.com/mail/?${params.toString()}`;
}
