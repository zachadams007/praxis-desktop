/**
 * actionOrigin - WHO asked for this action, which is the only thing that decides
 * whether a policy gate applies at all.
 *
 * Praxis has exactly two control surfaces and they have opposite safety models:
 *
 *   "live"       the owner spoke it or clicked it, just now, and is watching the screen
 *                while it happens. He directs every instruction in real time, so
 *                this is EQUIVALENT TO HIM CLICKING AND TYPING HIMSELF. It carries
 *                ZERO policy gates: no trust level, no sensitivity classifier, no
 *                veto, no confirmation. He IS the confirmation. The only things
 *                that stop a live action are HALT (his own stop button), the
 *                Computer Use master breaker (his own off switch), and physics -
 *                we are not in the desktop shell, so there is nothing to drive.
 *
 *   "unattended" A flow, an overnight run, a scheduler, a watcher. Nobody is
 *                looking at each step. THIS is what the trust dial governs, and it
 *                is the ONLY thing the trust dial governs. See autonomyPolicy.ts.
 *
 * Origin is a REQUIRED parameter everywhere it appears - never defaulted, never
 * optional, never inferred from ambient state. A missing origin must be a compile
 * error, so a future call site cannot silently inherit the permissive one.
 *
 * THE ONE TRAP: a live turn can START something that outlives it - Atlas calls `escalate`, or a
 * spoken instruction kicks off a flow that runs for an hour after the owner walks away. Origin is
 * captured at DISPATCH, and anything that detaches from the turn must be re-tagged "unattended"
 * at the point it detaches (see `detachedOrigin()`). Get this wrong and "live means no gates"
 * degrades into "anything can escape the gates by being started out loud".
 */

export type ActionOrigin = "live" | "unattended";

/**
 * The origin an action inherits once it outlives the turn that started it.
 *
 * A live instruction that spawns a long-horizon run (escalate → orchestrate, unattended loops,
 * FlowRunner waves) becomes unattended the moment it detaches: the owner asked for it while watching,
 * but he will not be watching step 40. Always ALWAYS "unattended" - this exists as a named
 * function rather than a literal so the reasoning sits at the call site instead of in a
 * reviewer's memory.
 */
export function detachedOrigin(): ActionOrigin {
  return "unattended";
}

/** True when this action is the owner driving the machine directly, right now. */
export function isLive(origin: ActionOrigin): boolean {
  return origin === "live";
}
