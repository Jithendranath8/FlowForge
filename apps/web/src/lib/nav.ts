/**
 * Full-page navigation, in one place: sign-in redirects, sign-out and workspace
 * switches leave the single-page app on purpose. (Tests replace these methods.)
 */
export const nav = {
  assign: (url: string) => window.location.assign(url),
  replace: (url: string) => window.location.replace(url),
  /** The sign-in page, coming back to where the visitor is now. */
  signInHere: () => `/sign-in?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`,
};
