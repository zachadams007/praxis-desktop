/** nodeText - the plain text inside a React node tree (strings and numbers, flattened). */

import { Children, isValidElement, type ReactNode } from "react";

export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return Children.toArray(node.props.children).map(textOf).join("");
  return "";
}
