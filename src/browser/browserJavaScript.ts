/** Durable authority for model-authored browser programs. */
export type BrowserJavaScriptPolicy = 'allow' | 'deny';

/** Resolve the run policy, requiring an explicit choice for authenticated
 * browser state because generated code receives that session's authority. */
export function assertJavaScriptPolicy(
  policy: BrowserJavaScriptPolicy | undefined,
  isAuthenticated: boolean,
): BrowserJavaScriptPolicy {
  if (policy !== undefined) return policy;
  if (isAuthenticated) {
    throw new Error(
      `An authenticated browser session must set javascriptPolicy explicitly ` +
        `('allow' or 'deny'): model-authored page JavaScript runs with the ` +
        `logged-in profile's full authority, so the exposure has to be chosen, ` +
        `not defaulted.`,
    );
  }
  return 'allow';
}
