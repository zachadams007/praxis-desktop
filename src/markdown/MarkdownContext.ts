/**
 * MarkdownContext - which surface a message is on, so a diagram inside it can match.
 * (CSS skinning is a class on the root; Mermaid needs the variant in JS to pick colours.)
 */

import { createContext } from "react";
import type { DiagramVariant } from "./mermaidTheme";

export interface MarkdownContextValue {
  variant: DiagramVariant;
}

export const MarkdownContext = createContext<MarkdownContextValue>({ variant: "atlas" });
