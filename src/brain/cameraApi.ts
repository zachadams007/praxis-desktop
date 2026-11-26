/**
 * cameraApi - a tiny imperative bridge to the ONE camera rig.
 *
 * The CameraRig owns the drei CameraControls instance and registers it here.
 * Gesture nav drives the camera through these helpers, so every input mode
 * moves the same rig. R2 (round3-remodel-lock): the map never rotates - the
 * gesture vocabulary is PAN + DOLLY, exactly like the pointer.
 */

interface ControlsLike {
  truck(x: number, y: number, enableTransition: boolean): Promise<void> | void;
  dolly(distance: number, enableTransition: boolean): Promise<void> | void;
}

let controls: ControlsLike | null = null;

export function setCameraControls(c: ControlsLike | null): void {
  controls = c;
}

/** Pan the rig in the view plane (world units). Used by gesture fist-drag. */
export function gesturePan(x: number, y: number): void {
  controls?.truck(x, y, false);
}

/** Dolly the rig (world units; +in / -out). */
export function gestureDolly(delta: number): void {
  controls?.dolly(delta, false);
}

/**
 * "Step out" of a drilled task IN PLACE - registered by the CameraRig. Frees the dolly
 * band and eases the camera out a little WITHOUT flying to a new framing, so exiting a
 * task leaves you over the same space, just zoomed out and unconstrained (the owner's spec).
 */
let stepOutFn: (() => void) | null = null;
export function setStepOut(fn: (() => void) | null): void {
  stepOutFn = fn;
}
export function cameraStepOut(): void {
  stepOutFn?.();
}

/**
 * Resolver registered by the CameraRig: the id of the node nearest the camera's
 * look-at - i.e. whatever is visually CENTERED. Powers the spread-gesture "drill
 * into the centered task / cluster" so it dives into what you're looking at, not
 * a parked cursor. Null when unregistered (headless) or nothing qualifies.
 */
let centeredResolver: (() => string | null) | null = null;
export function setCenteredResolver(fn: (() => string | null) | null): void {
  centeredResolver = fn;
}
export function getCenteredNode(): string | null {
  return centeredResolver ? centeredResolver() : null;
}

/**
 * Resolver registered by the CameraRig: given a SCREEN point in NDC (x,y ∈ [-1,1],
 * y up), return the id of the cluster / milestone nearest that point on screen.
 * Powers the gesture "point your hand at a cluster and push in → go THERE" - so the
 * drill targets what you're aiming at, not a stray centered node. Null if unresolved.
 */
let nodeAtScreenResolver: ((nx: number, ny: number) => string | null) | null = null;
export function setNodeAtScreenResolver(fn: ((nx: number, ny: number) => string | null) | null): void {
  nodeAtScreenResolver = fn;
}
export function getNodeAtScreen(nx: number, ny: number): string | null {
  return nodeAtScreenResolver ? nodeAtScreenResolver(nx, ny) : null;
}
