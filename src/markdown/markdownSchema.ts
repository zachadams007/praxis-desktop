/**
 * markdownSchema - the rehype-sanitize allow-list for every Atlas message.
 *
 * Starts from GitHub's schema (hast-util-sanitize's default: headings, lists, emphasis,
 * code, tables, links, task-list checkboxes) and removes what a chat bubble must never
 * load or run:
 *   - images, pictures, sources: a remote <img> is a tracking pixel and a request the owner
 *     never asked for; the answer is text-first, so they are dropped, not proxied;
 *   - link protocols other than http(s): no mailto:, no javascript:, no data:;
 *   - ids are prefixed so a model-written `id="root"` can't collide with the app's DOM.
 * `className` survives only where the default allows it (`language-*` on code, and the
 * task-list / footnote markers), so a message cannot attach arbitrary classes.
 */

import { defaultSchema, type Options } from "rehype-sanitize";

const BLOCKED_TAGS = new Set(["img", "picture", "source", "video", "audio", "iframe", "object", "embed"]);

export const MARKDOWN_SCHEMA: Options = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => !BLOCKED_TAGS.has(tag)),
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https"],
    cite: ["http", "https"],
    src: [],
  },
  clobberPrefix: "md-",
};
