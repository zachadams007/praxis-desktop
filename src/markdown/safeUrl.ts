/**
 * safeUrl - the one test for "may this link be followed".
 *
 * Atlas's words come from a model, and its web answers quote the open web, so every link
 * in them is untrusted. Only an absolute http(s) address is ever opened; anything else
 * (`javascript:`, `file:`, `data:`, `mailto:`, a relative path, a bare `#anchor`) is shown
 * as plain text instead of becoming something clickable. An address with a login in it
 * (`https://good.com@evil.com`) is refused too: the classic way to make a link read as one
 * site while pointing at another.
 */

/** The normalised absolute http(s) URL, or null when this must not become a link. */
export function safeHttpUrl(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const raw = href.trim();
  if (!raw || raw.length > 2048) return null;
  // No whitespace or control characters inside a URL we are about to hand to the shell.
  if (/[\u0000- \u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return url.href;
}
