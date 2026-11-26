/**
 * GLSL for the additive "neuron" glow system - one flexible Points material reused
 * for node halos, travelling pulses, and agent cores. Per-point attributes carry
 * size, brightness, and colour; additive blending + bloom does the rest.
 */

import * as THREE from "three";

export const GLOW_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aGlow;
  attribute vec3 aColor;
  varying float vGlow;
  varying vec3 vColor;
  void main() {
    vGlow = aGlow;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // perspective-correct point size, with a floor so distant points stay visible
    gl_PointSize = aSize * (300.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

export const GLOW_FRAG = /* glsl */ `
  precision highp float;
  uniform float uDim; // global brightness multiplier (focus/journey fade); 1 = full
  varying float vGlow;
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    // soft round falloff
    float core = smoothstep(0.5, 0.0, d);
    float a = core * core * clamp(vGlow, 0.0, 1.6) * uDim;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor * (0.45 + core * 0.9), a);
  }
`;

/** Build an additive glow Points material. `uDim` (default 1) lets a caller fade
 *  a whole points cloud (e.g. a cluster knot) without per-point rewrites. */
export function makeGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: { uDim: { value: 1 } },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
// Simplex noise (Ashima/ijm, MIT) - shared by the core + tendril shaders
// ---------------------------------------------------------------------------

export const SNOISE = /* glsl */ `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
`;

// ---------------------------------------------------------------------------
// The Praxis core - a contained synthetic energy organism (design lock §core).
// Noise-displaced sphere: uBreath = slow idle life, uTalk = fast flutter while
// the orchestrator is active. Dark interior + hot fresnel rim reads "contained
// plasma", and HDR output makes it the bloom anchor.
// ---------------------------------------------------------------------------

export const CORE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uBreath;
  uniform float uTalk;
  varying vec3 vN;
  varying vec3 vViewPos;
  varying float vDisp;
  ${"" /* snoise is prepended by the material factory */}
  void main() {
    float slow = snoise(position * 1.7 + vec3(0.0, uTime * 0.16, 0.0));
    float fast = snoise(position * 4.6 + vec3(uTime * 1.7, 0.0, uTime * 0.9));
    float disp = uBreath * 0.085 * slow + uTalk * 0.14 * fast;
    vDisp = disp;
    vec3 p = position * (1.0 + disp);
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

export const CORE_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform vec3 uDeep;
  uniform float uTalk;
  varying vec3 vN;
  varying vec3 vViewPos;
  varying float vDisp;
  void main() {
    vec3 V = normalize(-vViewPos);
    float ndv = clamp(dot(normalize(vN), V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 1.9);
    // ice heart (R5): HOT center melting into the surrounding plexus at the
    // rim — inverted from the old ring-rim plasma, which read as a donut
    vec3 col = mix(uColor * 2.0, uDeep * 0.7, fres);
    // displacement crests light up while it "talks"
    col += uColor * max(vDisp, 0.0) * (5.0 + uTalk * 14.0);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const SHELL_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vViewPos;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

export const SHELL_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec3 vN;
  varying vec3 vViewPos;
  void main() {
    vec3 V = normalize(-vViewPos);
    // BackSide shell: rim where the normal grazes the view
    float fres = pow(1.0 - abs(dot(normalize(vN), V)), 2.6);
    gl_FragColor = vec4(uColor * fres * uStrength, fres * uStrength);
  }
`;

export function makeCoreMaterial(color: THREE.Color, deep: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SNOISE + CORE_VERT,
    fragmentShader: CORE_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uBreath: { value: 1 },
      uTalk: { value: 0 },
      uColor: { value: color.clone() },
      uDeep: { value: deep.clone() },
    },
  });
}

export function makeShellMaterial(color: THREE.Color, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    uniforms: { uColor: { value: color.clone() }, uStrength: { value: strength } },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
//                   0.7 = C2.xyz · 0.9 = hue.rgb+radius
// ---------------------------------------------------------------------------

export const TENDRIL_VERT = /* glsl */ `
  attribute float aEdge;
  attribute float aT;
  attribute float aTheta;
  uniform sampler2D uEdgeTex;
  uniform float uTexW;
  uniform float uTime;
  uniform float uJourney;
  varying float vBright;
  varying float vAct;
  varying float vFocus;
  varying float vT;
  varying vec3 vHue;
  varying float vPulseHead; // 0..1 position of a travelling pulse on this edge
  varying float vPulseGlow; // its brightness (0 = no pulse riding this path)
  varying float vPulseKind; // 0 signal (warm) · 1 memory (cool)
  void main() {
    // 6 texture rows (texel centres for a height-6 DataTexture, NearestFilter):
    //   A · B · C1 · C2 · hue · pulse
    float u = (aEdge + 0.5) / uTexW;
    vec4 ta = texture2D(uEdgeTex, vec2(u, 0.083333)); // A.xyz, activity
    vec4 tb = texture2D(uEdgeTex, vec2(u, 0.25));     // B.xyz, brightness
    vec4 t1 = texture2D(uEdgeTex, vec2(u, 0.416667)); // C1.xyz, focus
    vec4 t2 = texture2D(uEdgeTex, vec2(u, 0.583333)); // C2.xyz
    vec4 td = texture2D(uEdgeTex, vec2(u, 0.75));     // hue.rgb, radius
    vec4 tp = texture2D(uEdgeTex, vec2(u, 0.916667)); // pulse: headT, glow, kind
    vec3 A = ta.xyz;
    vec3 B = tb.xyz;
    vec3 C1 = t1.xyz;
    vec3 C2 = t2.xyz;
    float act = ta.w;
    float bright = tb.w;
    float focus = t1.w;
    vec3 hue = td.rgb;
    float radius = td.w;
    // CUBIC Bézier spine + analytic tangent at aT — radial tangents at BOTH ends
    // (C1 outward from A, C2 outward into B) give the spider-branch elbow shape
    float t = aT;
    float mt = 1.0 - t;
    vec3 spine = mt * mt * mt * A + 3.0 * mt * mt * t * C1 + 3.0 * mt * t * t * C2 + t * t * t * B;
    vec3 deriv = 3.0 * mt * mt * (C1 - A) + 6.0 * mt * t * (C2 - C1) + 3.0 * t * t * (B - C2);
    vec3 T = normalize(deriv + vec3(1e-5));
    vec3 up = abs(T.y) > 0.92 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 N = normalize(cross(T, up));
    vec3 Bv = cross(T, N);
    // taper parent → child, swell slightly with activity
    float activitySwell = mix(0.24, 0.08, uJourney);
    float r = radius * mix(1.0, 0.42, t) * (1.0 + min(act, 1.0) * activitySwell);
    // LOCAL PULSE SWELL — where a travelling pulse rides, fatten the tube so the
    // illuminated segment reads as a light-carrying rail even fully zoomed out.
    // Pure add-on: pulseGlow (tp.y) is 0 at rest → r is byte-identical to before.
    float pulseHead = tp.x;
    float pulseGlow = tp.y;
    float dHeadV = t - pulseHead;
    float swell = exp(-dHeadV * dHeadV * 55.0) * pulseGlow;
    r *= 1.0 + swell * mix(0.42, 0.12, uJourney);
    vec3 p = spine + (N * cos(aTheta) + Bv * sin(aTheta)) * r;
    vBright = bright;
    vAct = act;
    vFocus = focus;
    vHue = hue;
    vT = t;
    vPulseHead = pulseHead;
    vPulseGlow = pulseGlow;
    vPulseKind = tp.z;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

export const TENDRIL_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uAccent;
  uniform vec3 uCool;
  uniform float uTime;
  uniform float uJourney;
  varying float vBright;
  varying float vAct;
  varying float vFocus;
  varying float vT;
  varying vec3 vHue;
  varying float vPulseHead;
  varying float vPulseGlow;
  varying float vPulseKind;
  void main() {
    // --- LOCAL PULSE ILLUMINATION (the "lights light up their pathway" fix) ---
    // A comet band riding the exact segment a travelling pulse is on: a crisp
    // leading edge at the head + a longer trailing glow behind it, in the pulse's
    // colour. It is gated ONLY on vPulseGlow (0 when no pulse rides this edge), so
    // it is fully INDEPENDENT of the path's base brightness/LOD — a dim, zoomed-out
    // context edge still lights up under its pulse. At rest vPulseGlow == 0 → this
    // contributes nothing and the pathway is byte-identical to before.
    float dHead = vT - vPulseHead;      // >0 ahead of the head (toward child)
    float ahead = max(dHead, 0.0);
    float behind = max(-dHead, 0.0);
    float headTerm = exp(-ahead * ahead * 380.0);  // crisp leading edge
    float tailTerm = exp(-behind * behind * 20.0); // long trailing comet tail
    float band = max(headTerm, tailTerm * 0.85);
    // A pulse is information, not a floodlight. Journey is a reading surface, so
    // keep the moving packet crisp and subordinate to the dependency geometry.
    float pEnergy = band * min(vPulseGlow, 1.0) * mix(0.68, 0.22, uJourney);

    // discard only when the base tube is dim AND no pulse rides here — so a pulse on
    // an otherwise-invisible rail is never culled away (the whole point of the fix)
    if (vBright < 0.004 && pEnergy < 0.004) discard;
    // base color = the path's area hue, brightening to the accent as it fires —
    // so color tells you WHICH initiative and WHETHER it is live
    vec3 col = mix(vHue, uAccent, clamp(vAct, 0.0, 1.0));
    // directional flow — a short TRAIN of beads rides each path parent→child
    // (vT 0→1 = toward the child / the area), so motion always reads as a
    // direction, never random sway. A trunk / focused path carries a GENTLE
    // always-on drift (the map breathes toward the areas, R9-sanctioned because
    // it is directional + meaningful); a firing edge surges faster + brighter.
    // An idle CONTEXT edge (vFocus 0, vAct 0) has flow 0 → perfectly still.
    float speed = 0.14 + vAct * 0.55;
    float phase = vT - uTime * speed;
    float train = 0.0;
    for (int i = 0; i < 3; i++) {
      float c = fract(phase + float(i) / 3.0);
      train += smoothstep(0.12, 0.0, min(c, 1.0 - c));
    }
    float drive = clamp(vFocus * 0.16 + vAct, 0.0, 1.4);
    float flow = train * drive;
    // a bead also pulls the color toward the hot accent as it passes
    col = mix(col, uAccent, flow * 0.35);
    // CORE CLEARANCE — fade each path to nothing at its parent end (vT→0, the hub
    // for trunks) so the luminous spokes EMERGE from the rim of the neural core and
    // brighten outward toward their region, instead of slicing bright bars straight
    // through the centre (the lens-flare "cruciform" + central white blow-out the
    // review flagged across every lens). The cellular web stays the hero.
    float coreClear = smoothstep(0.0, 0.26, vT);
    // focus crispens the core; context paths stay calm and dim
    float energy = vBright * (1.0 + flow * 0.85) * (0.85 + vFocus * 0.4) * coreClear;
    // R16: soft tone-map so a firing path glows hot but NEVER clips to a
    // featureless white blob — bright stays detailed (hue preserved); the
    // bloom pass adds the halo. The exp curve asymptotes to 1.0, never exceeds.
    vec3 outc = vec3(1.0) - exp(-col * energy * 1.7);
    // add the local pulse glow ON TOP (additive, HDR so the bloom pass haloes it).
    // Colour = the path's own hue pushed hot toward the accent (signal) or cool
    // (memory packet), with a white-hot leading edge — reads as the pulse's light
    // washing along the rail. Core-cleared like the base spokes so it never blows
    // out the very centre. pEnergy == 0 at rest → outc unchanged (at-rest identical).
    vec3 pHue = mix(vHue, uAccent, 0.6);
    pHue = mix(pHue, uCool, clamp(vPulseKind, 0.0, 1.0) * 0.8);
    vec3 pCol = mix(pHue, vec3(1.0), headTerm * 0.5);
    outc += pCol * pEnergy * mix(0.95, 0.55, uJourney) * coreClear;
    gl_FragColor = vec4(outc, 1.0);
  }
`;

export function makeTendrilMaterial(
  edgeTex: THREE.DataTexture,
  texW: number,
  accent: THREE.Color,
  cool: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TENDRIL_VERT,
    fragmentShader: TENDRIL_FRAG,
    uniforms: {
      uEdgeTex: { value: edgeTex },
      uTexW: { value: texW },
      uTime: { value: 0 },
      uJourney: { value: 0 },
      uAccent: { value: accent.clone() },
      uCool: { value: cool.clone() },
    },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
}

// ---------------------------------------------------------------------------
// Synapse flickers - small INDIVIDUAL blinks deep in the web (design lock §3).
// Points are pre-distributed around every node slot at build time; each frame
// the vertex shader reads the node's live position + activity from a texture.
// Density gating: a point only participates when the local work level exceeds
// its threshold - so flicker density literally rises on the side of the brain
// where tasks run, and NOTHING flows.
// ---------------------------------------------------------------------------

export const FLICKER_VERT = /* glsl */ `
  attribute float aNode;
  attribute vec3 aOffset;
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aThreshold;
  attribute float aSize;
  attribute float aSector;
  attribute float aWarm;
  uniform sampler2D uNodeTex;
  uniform float uTexW;
  uniform float uTime;
  uniform float uSectorWork[8]; // per-cluster live work → firing concentrates there
  uniform float uFocusDist;
  uniform float uDofRange;
  varying float vSpark;
  varying float vHeat;
  varying float vWarm;
  varying float vDepth;
  void main() {
    float u = (aNode + 0.5) / uTexW;
    vec4 r0 = texture2D(uNodeTex, vec2(u, 0.25)); // xyz = pos, w = activity
    vec4 r1 = texture2D(uNodeTex, vec2(u, 0.75)); // x = reveal, y = ambient
    float work = max(0.0, r0.w - r1.y * 1.6);
    // firing density = a faint everywhere baseline + a strong surge in the SECTOR
    // currently being worked → the side of the brain doing work fires denser+hotter
    float sw = uSectorWork[int(mod(aSector + 0.5, 8.0))];
    float density = clamp(work * 0.55 + sw * 1.7, 0.0, 1.0);
    // a point exists only when local work exceeds its threshold
    float on = step(aThreshold, density);
    // sharp individual blinks — never a stream
    float wave = sin(uTime * aSpeed + aPhase);
    float spark = smoothstep(0.86, 0.985, wave);
    // overview still shows side-density; close-up respects LOD reveal
    float vis = max(r1.x, 0.45);
    vSpark = spark * on * vis;
    vHeat = density;
    vWarm = aWarm;
    vec3 p = r0.xyz + aOffset;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float viewDist = max(-mv.z, 0.001);
    // depth grade matches the soma/dendrite DoF: front sparks pop, back recede
    vDepth = mix(1.25, 0.5, smoothstep(-1.0, 1.0, (viewDist - uFocusDist) / uDofRange));
    gl_PointSize = aSize * (300.0 / viewDist) * (0.7 + 0.5 * spark);
    gl_Position = projectionMatrix * mv;
  }
`;

export const FLICKER_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uCool;
  uniform vec3 uHot;
  uniform vec3 uWarm;
  varying float vSpark;
  varying float vHeat;
  varying float vWarm;
  varying float vDepth;
  void main() {
    if (vSpark < 0.01) discard;
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float core = smoothstep(0.5, 0.05, d);
    float a = core * core * vSpark * vDepth;
    if (a < 0.004) discard;
    // electric blue-white core → amber as it heats; a fraction fire hot red/orange
    vec3 col = mix(uCool, uHot, clamp(vHeat * 1.1, 0.0, 1.0));
    col = mix(col, uWarm, vWarm * clamp(vHeat * 1.3, 0.0, 1.0));
    gl_FragColor = vec4(col * (0.6 + core), a);
  }
`;

export function makeFlickerMaterial(
  nodeTex: THREE.DataTexture,
  texW: number,
  cool: THREE.Color,
  hot: THREE.Color,
  warm: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FLICKER_VERT,
    fragmentShader: FLICKER_FRAG,
    uniforms: {
      uNodeTex: { value: nodeTex },
      uTexW: { value: texW },
      uTime: { value: 0 },
      uSectorWork: { value: new Float32Array(8) },
      uFocusDist: { value: 26 },
      uDofRange: { value: 11 },
      uCool: { value: cool.clone() },
      uHot: { value: hot.clone() },
      uWarm: { value: warm.clone() },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
// The plexus brain (lock R5) - one Points mass (neurons) + one LineSegments web
// (filaments) + a haze shell + the plasma heart. The load-bearing trick: every
// displacement is PURELY a function of (rest position, uniforms) - both
// materials share the exact same GLSL chunk, so line endpoints and neuron
// points move identically and the web never detaches. All motion is uniform-
// driven from static buffers; zero per-frame geometry work.
// ---------------------------------------------------------------------------

export const PLEXUS_DISPLACE = /* glsl */ `
  uniform float uTime;
  uniform float uBreath;
  uniform float uTalk;
  uniform float uRadius; // world radius of the core (for the world-space depth cue)
  vec3 plexusDisplace(vec3 p) {
    float slow = snoise(p * 0.9 + vec3(0.0, uTime * 0.10, 0.0));
    vec3 fast = vec3(
      snoise(p * 2.3 + vec3(uTime * 0.9, 0.0, 0.0)),
      snoise(p * 2.3 + vec3(0.0, uTime * 0.9, 7.3)),
      snoise(p * 2.3 + vec3(3.1, 0.0, uTime * 0.9)));
    float pulse = 1.0 + 0.010 * sin(uTime * 0.55);
    return p * pulse + normalize(p + 1e-4) * (uBreath * 0.05 * slow) + fast * (uTalk * 0.07);
  }
`;

// radius gradient: ice heart → electric web → deep rim; warm ONLY on activity
// (R9 discipline). When the palette ships a spectrum ramp (Plasma), the in-brain
// multicolor comes from indexing it by radius + sector - inside the brain only.
const PLEXUS_COLOR = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uCool;
  uniform vec3 uDeep;
  uniform vec3 uAccent;
  uniform vec3 uSpec0;
  uniform vec3 uSpec1;
  uniform vec3 uSpec2;
  uniform vec3 uSpec3;
  uniform float uSpecMix;
  uniform vec3 uSectorCol[8]; // per-cluster accent hue, indexed by brain sector
  vec3 plexusColor(float r, float sector, float warm) {
    // each lobe of the brain glows its CLUSTER's accent hue, so the connectome
    // and the cluster medallions read as one organism (the brain ⇄ map blend).
    int si = int(mod(sector + 0.5, 8.0));
    vec3 hue = uSectorCol[si];
    // hot ice core (with a hint of cool) melting OUT into the region hue across
    // the cortex; deepen the far fringe a touch so the silhouette recedes.
    vec3 col = mix(mix(uCore, uCool, 0.22), hue, smoothstep(0.05, 0.40, r));
    col = mix(col, mix(hue, uDeep, 0.5), smoothstep(0.80, 1.08, r));
    if (uSpecMix > 0.001) {
      float t = clamp(r * 0.85 + sector * 0.05, 0.0, 1.0);
      vec3 spec = mix(uSpec0, uSpec1, smoothstep(0.0, 0.4, t));
      spec = mix(spec, uSpec2, smoothstep(0.35, 0.7, t));
      spec = mix(spec, uSpec3, smoothstep(0.65, 1.0, t));
      col = mix(col, spec, uSpecMix);
    }
    return mix(col, uAccent, warm * 0.85);
  }
`;

export const PLEXUS_POINT_VERT = /* glsl */ `
  attribute float aR;
  attribute float aSeed;
  attribute float aSize;
  attribute float aSector;
  uniform sampler2D uActTex;
  varying vec3 vCol;
  varying float vFade;
  void main() {
    vec3 p = plexusDisplace(position);
    vec4 act = texture2D(uActTex, vec2((aSector + 0.5) / 8.0, 0.5));
    // rare individual twinkles, gated by the sector's burst envelope
    float tw = sin(uTime * (1.2 + aSeed * 2.6) + aSeed * 43.0);
    float spark = smoothstep(0.93, 1.0, tw) * step(aSeed, act.y * 1.35);
    // warm is EVENT heat: sparks carry it; sustained work only simmers,
    // so an active hemisphere never turns permanently pink
    float warm = clamp(act.x * 0.22 + spark, 0.0, 1.0);
    vCol = plexusColor(aR, aSector, warm);
    // volumetric depth from WORLD z (camera looks down +z at the core origin), so
    // the cue survives the slow tumble: the back half recedes hard, the front pops
    vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
    float zFade = mix(0.08, 1.18, smoothstep(-uRadius * 0.95, uRadius * 0.85, wp.z));
    // mass sits UNDER the bloom threshold; only sparks + heart cross it
    float base = mix(0.30, 0.10, smoothstep(0.12, 0.75, aR));
    vFade = (base + act.x * 0.10 + spark * 1.25) * zFade;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * (300.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

export const PLEXUS_POINT_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vCol;
  varying float vFade;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float core = exp(-d * d * 6.0);
    float halo = exp(-d * d * 1.6) * 0.35;
    float a = (core + halo) * vFade;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vCol * (0.5 + core * 1.1), a);
  }
`;

export const PLEXUS_LINE_VERT = /* glsl */ `
  attribute float aAlong;
  attribute float aFR;
  attribute float aFSeed;
  attribute float aFSector;
  uniform sampler2D uActTex;
  varying vec3 vCol;
  varying float vBright;
  void main() {
    vec3 p = plexusDisplace(position);
    vec4 act = texture2D(uActTex, vec2((aFSector + 0.5) / 8.0, 0.5));
    // travelling spark: a narrow window sweeping aAlong, staggered by seed,
    // gated by the sector burst — the only filament light that crosses bloom
    float head = fract(uTime * (0.35 + aFSeed * 0.5) + aFSeed * 7.0);
    float spark = smoothstep(0.10, 0.0, abs(aAlong - head)) * step(aFSeed, act.y * 1.4);
    vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
    float zFade = mix(0.08, 1.18, smoothstep(-uRadius * 0.95, uRadius * 0.85, wp.z));
    // the web is the brain's body — filaments carry the density read
    vBright = (0.14 + 0.1 * aFSeed + act.x * 0.12 + spark * 1.3) * zFade;
    float warm = clamp(act.x * 0.22 + spark, 0.0, 1.0);
    vCol = plexusColor(aFR, aFSector, warm);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

export const PLEXUS_LINE_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vCol;
  varying float vBright;
  void main() {
    if (vBright < 0.004) discard;
    gl_FragColor = vec4(vCol * vBright, 1.0);
  }
`;

export type PlexusUniforms = Record<string, THREE.IUniform>;

/** Shared uniform record - pass the SAME object to both factories so the
 *  points and filaments are driven by one per-frame write. */
export function makePlexusUniforms(
  actTex: THREE.DataTexture,
  core: THREE.Color,
  cool: THREE.Color,
  deep: THREE.Color,
  accent: THREE.Color,
  radius: number,
  sectorCols: Float32Array, // 8 × vec3 (linear rgb), indexed by brain sector
  spectrum?: [string, string, string, string],
): PlexusUniforms {
  const spec = (spectrum ?? ["#000000", "#000000", "#000000", "#000000"]).map(
    (h) => new THREE.Color(h),
  );
  return {
    uTime: { value: 0 },
    uBreath: { value: 0.7 },
    uTalk: { value: 0 },
    uRadius: { value: radius },
    uActTex: { value: actTex },
    uCore: { value: core.clone() },
    uCool: { value: cool.clone() },
    uDeep: { value: deep.clone() },
    uAccent: { value: accent.clone() },
    uSectorCol: { value: sectorCols },
    uSpec0: { value: spec[0] },
    uSpec1: { value: spec[1] },
    uSpec2: { value: spec[2] },
    uSpec3: { value: spec[3] },
    uSpecMix: { value: spectrum ? 0.6 : 0 },
  };
}

export function makePlexusPointsMaterial(uniforms: PlexusUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SNOISE + PLEXUS_DISPLACE + PLEXUS_COLOR + PLEXUS_POINT_VERT,
    fragmentShader: PLEXUS_POINT_FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export function makePlexusLinesMaterial(uniforms: PlexusUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SNOISE + PLEXUS_DISPLACE + PLEXUS_COLOR + PLEXUS_LINE_VERT,
    fragmentShader: PLEXUS_LINE_FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
// Dendrite spray (the "actually 3D" fix, 2026-06-14) - thousands of fine
// filaments shooting OUTWARD from the core into full 3D space in every
// direction. This is what makes the centerpiece read volumetric instead of a
// flat additive disc: filaments aimed toward/away from camera foreshorten into
// short bright stubs while side-on ones streak long, so depth is legible even
// in a still, straight-on frame (the camera never orbits - R2). Color is baked
// per-vertex from the cluster sector the filament points at, so the multicolor
// IS information (which initiative that lobe feeds) and the brain ties to the
// map. One merged LineSegments, built once per (variant, palette); all motion
// is uniform-driven (sway + breath + a travelling bead gated by sector work).
// ---------------------------------------------------------------------------

export const DENDRITE_VERT = /* glsl */ `
  attribute float aAlong;   // 0 at the root (in the mass) .. 1 at the tip
  attribute float aSeed;
  attribute float aSector;  // which cluster lobe this filament feeds
  attribute float aLen;     // 0..1 normalized length (longer = fainter)
  attribute vec3 aPerp;     // baked sway axis (unit, perpendicular-ish to the filament)
  attribute vec3 aCol;      // baked cluster hue (linear rgb)
  uniform sampler2D uActTex;
  uniform float uTime;
  uniform float uBreath;
  uniform float uTalk;
  uniform vec3 uCore;
  varying vec3 vCol;
  varying float vBright;
  void main() {
    vec3 p = position;
    // sway grows toward the tip, pinned at the root (sin pin), with a fast
    // talk-driven flutter layered on the slow idle drift
    float pin = aAlong;
    float drift = sin(uTime * 0.5 + aSeed * 40.0) * 0.10;
    float flutter = sin(uTime * 3.1 + aSeed * 17.0) * uTalk * 0.10;
    p += aPerp * (drift + flutter) * pin * (0.6 + aLen);
    // breath gently extends the tips when the core is busy / talking
    p *= 1.0 + (uBreath - 0.7) * 0.05 * aAlong + uTalk * 0.06 * aAlong;
    vec4 act = texture2D(uActTex, vec2((aSector + 0.5) / 8.0, 0.5));
    // hot, near-white at the root → cluster hue along the shaft
    vCol = mix(mix(uCore, aCol, 0.55), aCol, smoothstep(0.0, 0.5, aAlong));
    // bright near the root, falling off toward the tip; long filaments dimmer
    float along = 1.0 - aAlong;
    // idle filaments sit UNDER the bloom threshold — crisp matte fine-detail, not
    // a glowing hairball; only the travelling bead on a working sector crosses it
    float base = (0.055 + 0.17 * along * along) * (1.0 - aLen * 0.45);
    // a travelling bead races outward, gated by that sector's live work envelope
    float head = fract(uTime * (0.22 + aSeed * 0.4) + aSeed * 9.0);
    float bead = smoothstep(0.09, 0.0, abs(aAlong - head)) * (0.16 + act.x * 1.25);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // front pops, back recedes — the volumetric depth cue (uses rotated z)
    float zf = mix(0.34, 1.18, smoothstep(-1.4, 1.4, p.z));
    vBright = (base + bead) * zf;
    gl_Position = projectionMatrix * mv;
  }
`;

export const DENDRITE_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vCol;
  varying float vBright;
  void main() {
    if (vBright < 0.004) discard;
    gl_FragColor = vec4(vCol * vBright, 1.0);
  }
`;

export function makeDendriteMaterial(
  actTex: THREE.DataTexture,
  core: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: DENDRITE_VERT,
    fragmentShader: DENDRITE_FRAG,
    uniforms: {
      uActTex: { value: actTex },
      uTime: { value: 0 },
      uBreath: { value: 0.7 },
      uTalk: { value: 0 },
      uCore: { value: core.clone() },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Fresnel rim + glow patch for the solid node cores (MeshBasicMaterial +
 * instanceColor). Reads a per-instance `aGlow` attribute to push firing nodes past
 * 1.0 so they bloom, plus an energy-sphere fresnel rim. Keeps instancing and
 * raycasting free (no custom geometry).
 */
export function patchNodeFresnel(mat: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute float aGlow;
         varying vec3 vViewNormal;
         varying vec3 vViewPos;
         varying float vGlow;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vGlow = aGlow;
         // MeshBasicMaterial never declares objectNormal (no beginnormal_vertex
         // chunk without envmap), so read the raw attribute — instances only
         // translate/uniform-scale here, so normalMatrix is valid for it
         vViewNormal = normalize(normalMatrix * normal);`,
      )
      .replace(
        "#include <project_vertex>",
        // instanceMatrix is applied INSIDE project_vertex, so the view-space
        // position must be captured after it - earlier and every instance's
        // fresnel would be computed as if it sat at the world origin
        `#include <project_vertex>
         vViewPos = mvPosition.xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec3 vViewNormal;
         varying vec3 vViewPos;
         varying float vGlow;`,
      )
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
         vec3 V = normalize(-vViewPos);
         float fres = pow(1.0 - clamp(dot(normalize(vViewNormal), V), 0.0, 1.0), 2.4);
         gl_FragColor.rgb += gl_FragColor.rgb * fres * 1.6;
         gl_FragColor.rgb *= (1.0 + clamp(vGlow, 0.0, 1.6) * 1.5);`,
      );
  };
  return mat;
}

/**
 * The NEURON material - a LIT, DEPTH-WRITING MeshStandardMaterial for the instanced
 * sphere-neurons that form the core mass (2026-06-16 volumetric rebuild).
 *
 * This is the fix every prior pass missed: the "neurons" were always additive GL
 * POINTS (billboards) which by construction never self-occlude, never catch light,
 * never foreshorten - so the mass always read FLAT no matter the fade tuning. Real
 * opaque lit spheres do all three: near neurons hide far ones (depthWrite), each is
 * shaded light-side/dark-side by the scene key light (form), and perspective
 * foreshortens them. N8AO + DoF (which need real depth geometry) finally bite.
 *
 * Patched onto MeshStandardMaterial (keeps three's instancing + lighting + AO + fog
 * + tonemapping for free):
 *   - per-instance `aGlow` → cool→hot emissive FIRING (neurons fire deep near the
 *     active sector; the hot ones cross the bloom floor and glow).
 *   - a fresnel rim sheen so every lit neuron has a techy energy edge.
 * Sector hue rides `instanceColor` (diffuse). Lights live in Brain.tsx.
 */
// ===========================================================================
// THE VOLUMETRIC NEURAL CORE (2026-06-16 rebuild #5) - soft glowing SOMAS +
// a dominant branching DENDRITE web, sold as 3D by IN-SHADER DEPTH-OF-FIELD.
//
// Why this, after the lit-sphere "candy balls" were rejected: the make-or-break
// for reading 3D in a STILL, no-orbit frame (R2) is depth-of-field + depth-graded
// size/brightness, NOT opaque occluding geometry. A soft additive glow field with
// REAL per-element bokeh reads more volumetric than any solid ball mass. And the
// postprocessing <DepthOfField> pass CANNOT grade additive glow per-element (glow
// writes no depth), so the depth cue is computed HERE, per vertex, from view-space
// z vs a focus plane:
//   coc (circle-of-confusion) = |viewDist − focusDist| / dofRange   (0=sharp, 1=blur)
//   out-of-focus  → bigger + softer-edged + dimmer (energy spreads over its disc)
//   behind focus  → dimmer than the same distance in front (atmospheric depth)
// Pair that with strong base size+brightness variance through a real z-volume and
// the still frame reads as a deep neural net: a sharp bright soma up front, soft
// dim somas receding into blur - exactly the reference.
// ===========================================================================

// shared bokeh helper - `signed` is +behind focus / −in front; coc is its abs.
const DOF_CHUNK = /* glsl */ `
  uniform float uFocusDist;  // world distance camera→focus plane
  uniform float uDofRange;   // half-depth that maps to full blur
  uniform float uBokeh;      // how much an out-of-focus element grows
  float dofSigned(float viewDist) { return (viewDist - uFocusDist) / uDofRange; }
`;

// --- SOMAS: billboarded glowing cell bodies (bright nucleus + soft halo) -----
export const SOMA_VERT = /* glsl */ `
  attribute float aSize;    // base local size
  attribute float aBright;  // base brightness
  attribute float aSeed;
  attribute float aSector;  // cluster lobe (hue)
  attribute float aHero;    // 0 faint background .. 1 hero soma (whiter, sharper)
  uniform float uTime;
  uniform float uModelScale; // live group scale (so somas track breath/journey shrink)
  uniform float uPxScale;
  uniform sampler2D uActTex;
  uniform vec3 uCore;
  uniform vec3 uSectorCol[8];
  varying float vCoc;
  varying float vPeak;
  varying float vHero;
  varying vec3 vCol;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float viewDist = max(-mv.z, 0.001);
    float signed = dofSigned(viewDist);
    float coc = clamp(abs(signed), 0.0, 1.0);
    vCoc = coc;
    vec4 act = texture2D(uActTex, vec2((aSector + 0.5) / 8.0, 0.5));
    float tw = 0.5 + 0.5 * sin(uTime * (0.5 + aSeed * 1.7) + aSeed * 40.0);
    // depth grade: the back hemisphere recedes hard (dim), the front pops
    float depthDim = mix(1.32, 0.20, smoothstep(-1.0, 1.0, signed));
    // out-of-focus peak drops as its energy spreads over a wider disc
    float focusDim = mix(1.0, 0.32, coc);
    vPeak = aBright * depthDim * focusDim * (0.80 + 0.30 * tw + act.x * 0.55);
    int si = int(mod(aSector + 0.5, 8.0));
    vCol = mix(uSectorCol[si], uCore, 0.18 + 0.45 * aHero);
    vHero = aHero;
    float sz = aSize * uModelScale * (1.0 + coc * uBokeh);
    gl_PointSize = sz * (uPxScale / viewDist);
    gl_Position = projectionMatrix * mv;
  }
`;

export const SOMA_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uCore;
  varying float vCoc;
  varying float vPeak;
  varying float vHero;
  varying vec3 vCol;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0; // 0 centre .. 1 edge
    // gaussian tightens at focus (crisp nucleus), broadens when blurred (bokeh disc)
    float k = mix(7.5, 1.25, vCoc);
    float core = exp(-d * d * k);
    float halo = exp(-d * d * 1.15) * 0.26;
    float a = (core + halo) * vPeak;
    if (a < 0.004) discard;
    // hot blue-white nucleus melting into the cluster hue toward the rim
    vec3 col = mix(vCol, uCore, core * core * (0.45 + 0.55 * vHero));
    gl_FragColor = vec4(col * (0.5 + core * 1.1), clamp(a, 0.0, 1.0));
  }
`;

export function makeSomaMaterial(
  actTex: THREE.DataTexture,
  core: THREE.Color,
  sectorCols: Float32Array,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: DOF_CHUNK + SOMA_VERT,
    fragmentShader: SOMA_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uModelScale: { value: 8 },
      uPxScale: { value: 110 },
      uFocusDist: { value: 26 },
      uDofRange: { value: 9 },
      uBokeh: { value: 4.4 },
      uActTex: { value: actTex },
      uCore: { value: core.clone() },
      uSectorCol: { value: sectorCols },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}

// --- DENDRITES: camera-facing tapered glowing ribbons (the dominant structure) -
// One merged BufferGeometry of ribbon quads. The vertex shader expands each
// segment endpoint perpendicular to its screen-projected direction (meshline
// technique) by a WORLD half-width, so primaries read thick and tips taper to
// fine glowing threads. Width grows + edge softens with bokeh; brightness depth-
// grades like the somas. Colour runs white-hot at the soma root → cluster hue
// along the shaft. The ONLY motion is a work-gated bead travelling root→tip
// (information, not perpetual sway) - the slow object tumble gives parallax.
export const ARBOR_VERT = /* glsl */ `
  attribute vec3 aOther;   // the segment's other endpoint (for screen direction)
  attribute float aSide;   // -1 / +1 (which edge of the ribbon)
  attribute float aWidth;  // local half-width at this endpoint
  attribute float aAlong;  // 0 at the soma root .. 1 at the finest tip
  attribute float aSeed;
  attribute float aSector;
  attribute vec3 aCol;     // baked cluster hue (linear rgb)
  uniform float uTime;
  uniform float uModelScale;
  uniform sampler2D uActTex;
  uniform vec3 uCore;
  varying float vAcross;
  varying float vCoc;
  varying float vBright;
  varying vec3 vCol;
  void main() {
    vec3 mvCur = (modelViewMatrix * vec4(position, 1.0)).xyz;
    vec3 mvOther = (modelViewMatrix * vec4(aOther, 1.0)).xyz;
    float viewDist = max(-mvCur.z, 0.001);
    float signed = dofSigned(viewDist);
    float coc = clamp(abs(signed), 0.0, 1.0);
    vCoc = coc;
    vec3 dir = normalize(mvCur - mvOther + vec3(1e-5));
    vec3 toCam = normalize(-mvCur);
    vec3 side = normalize(cross(dir, toCam) + vec3(1e-5));
    float w = aWidth * uModelScale * (1.0 + coc * uBokeh * 2.2);
    vec3 p = mvCur + side * (aSide * w);
    vAcross = aSide;
    // electric blue-white at the soma root → the cluster-sector hue toward the
    // fine tips, so the CORE reads cohesively electric-blue (Ref A) while the
    // outer web blooms the cluster multicolor (R7 cluster identity)
    vCol = mix(uCore, aCol, smoothstep(0.12, 0.62, aAlong));
    vec4 act = texture2D(uActTex, vec2((aSector + 0.5) / 8.0, 0.5));
    float along = 1.0 - aAlong;
    float base = 0.065 + 0.42 * along * along;         // thick & bright at root
    float depthDim = mix(1.30, 0.18, smoothstep(-1.0, 1.0, signed));
    float focusDim = mix(1.0, 0.42, coc);
    // a firing bead races outward, gated by that lobe's live work
    float head = fract(uTime * (0.24 + aSeed * 0.4) + aSeed * 9.0);
    float bead = smoothstep(0.075, 0.0, abs(aAlong - head)) * (0.15 + act.x * 1.4);
    vBright = (base + bead + act.x * 0.12) * depthDim * focusDim;
    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`;

export const ARBOR_FRAG = /* glsl */ `
  precision highp float;
  varying float vAcross;
  varying float vCoc;
  varying float vBright;
  varying vec3 vCol;
  void main() {
    // bright spine, soft edge — softens further when blurred
    float k = mix(6.5, 1.5, vCoc);
    float prof = exp(-vAcross * vAcross * k);
    float a = prof * vBright;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vCol * a, 1.0);
  }
`;

export function makeArborMaterial(
  actTex: THREE.DataTexture,
  core: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: DOF_CHUNK + ARBOR_VERT,
    fragmentShader: ARBOR_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uModelScale: { value: 8 },
      uFocusDist: { value: 26 },
      uDofRange: { value: 9 },
      uBokeh: { value: 4.4 },
      uActTex: { value: actTex },
      uCore: { value: core.clone() },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}

// ===========================================================================
// THE NUCLEUS - the core CENTER as an extreme neuron CLOSE-UP (2026-06-17).
//
// Per-cell hue is sampled from the cluster palette so the centre ties to the radial map. Warm
// only bleeds in with live work (R9). Self-luminous (no scene light → no "candy ball" specular);
// gently displaced so the silhouette stays organic, never a hard ball. Determinism: procedural,
// zero Math.random.
// ===========================================================================

// 3D Worley / cellular noise - returns vec3(F1, F2, cellId). The boundary glow
// is smoothstep(F2-F1) → the membrane web; F1 → organelle dot; cellId → per-cell
// hue. Feature points orbit on uTime so the tissue slowly lives.
const WORLEY = /* glsl */ `
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec3 worley(vec3 p, float t) {
    vec3 ip = floor(p);
    vec3 fp = fract(p);
    float f1 = 9.0, f2 = 9.0, id = 0.0;
    for (int k = -1; k <= 1; k++)
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec3 g = vec3(float(i), float(j), float(k));
      vec3 o = hash33(ip + g);
      o = 0.5 + 0.5 * sin(t + 6.2831 * o); // animate feature points → tissue breathes
      vec3 r = g + o - fp;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = hash13(ip + g); }
      else if (d < f2) { f2 = d; }
    }
    return vec3(sqrt(f1), sqrt(f2), id);
  }
`;

export const NUCLEUS_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uBreath;
  uniform float uTalk;
  varying vec3 vN;
  varying vec3 vViewPos;
  varying vec3 vObjPos;
  ${"" /* snoise prepended by the factory */}
  void main() {
    // ALWAYS-ON multi-scale displacement so the silhouette is organically lumpy
    // even in a still idle frame (never a clean ball), while staying well inside
    // the soma envelope — the dendrite ribbons (renderOrder 1) cross in front, so
    // the overall brain still reads as a connectome. Peak ~0.11 of unit radius.
    float lobe = snoise(position * 1.4 + vec3(3.0, uTime * 0.07, 0.0));  // few big bulges
    float slow = snoise(position * 2.1 + vec3(0.0, uTime * 0.12, 0.0));  // breath ripple
    float fast = snoise(position * 5.0 + vec3(uTime * 0.6, 0.0, 4.2));   // micro tremor
    float disp = 0.045 * lobe + uBreath * 0.030 * slow + uTalk * 0.035 * fast;
    vec3 p = position * (1.0 + disp);
    vObjPos = p;
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

export const NUCLEUS_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uWork;   // global live work 0..1 → the membrane fires brighter
  uniform float uTalk;
  uniform vec3 uCore;    // pale blue-white — the HOT nucleolus kernel only
  uniform vec3 uBlue;    // saturated ELECTRIC blue (baseCool) — web spines + rim + halo
  uniform vec3 uDeep;    // deep membrane tissue (never pure black)
  uniform vec3 uAccent;  // activity heat (R9: only with work)
  uniform vec3 uSectorCol[8];
  varying vec3 vN;
  varying vec3 vViewPos;
  varying vec3 vObjPos;
  void main() {
    vec3 V = normalize(-vViewPos);
    vec3 Nv = normalize(vN);
    float ndv = clamp(dot(Nv, V), 0.0, 1.0);

    // ---- warped, size-varying membrane (OBJECT space → glued to the specimen) ----
    // a low-freq domain warp makes boundaries wander instead of tiling, and a
    // per-region frequency field varies cell SIZE ~2x (big calm sacs .. tight
    // clusters) so it never reads as a uniform geodesic/soccer-ball grid.
    vec3 dir = normalize(vObjPos + 1e-5);
    vec3 warp = vec3(
      snoise(dir * 1.7 + vec3(0.0, uTime * 0.09, 0.0)),
      snoise(dir * 1.7 + vec3(5.2, uTime * 0.09, 1.7)),
      snoise(dir * 1.7 + vec3(9.1, 1.3, uTime * 0.09)));
    vec3 wdir = dir + 0.24 * warp;
    float freqField = mix(2.4, 4.8, 0.5 + 0.5 * snoise(dir * 1.25 + 11.0));
    vec3 w1 = worley(wdir * freqField, uTime * 0.40);          // primary compartments
    vec3 w2 = worley(wdir * (freqField * 2.6) + 17.0, uTime * 0.70); // fine filigree
    float edge1 = smoothstep(0.090, 0.0, w1.y - w1.x);         // glowing cell boundary
    float edge2 = smoothstep(0.045, 0.0, w2.y - w2.x);
    float organelle = smoothstep(0.30, 0.0, w1.x);             // domed dot per cell centre

    // ---- relief: derive a normal perturbation from the coarse boundary gradient
    // so the membrane web reads as RAISED 3D ridges the rim/key catch, not lines
    // painted on a sphere (derivative-free → works on WebGL1; coarse octave only) ----
    float eps = 0.013;
    float e0 = w1.y - w1.x;
    vec3 wX = worley((wdir + vec3(eps, 0.0, 0.0)) * freqField, uTime * 0.40);
    vec3 wY = worley((wdir + vec3(0.0, eps, 0.0)) * freqField, uTime * 0.40);
    vec3 wZ = worley((wdir + vec3(0.0, 0.0, eps)) * freqField, uTime * 0.40);
    vec3 grad = vec3((wX.y - wX.x) - e0, (wY.y - wY.x) - e0, (wZ.y - wZ.x) - e0) / eps;
    vec3 Np = normalize(Nv - grad * 0.35);                     // ridges push the normal
    float ndvR = clamp(dot(Np, V), 0.0, 1.0);
    float fres = pow(1.0 - ndvR, 2.2);                         // ridge-aware cool rim

    // ---- baked studio KEY in VIEW space → a stable lit cheek + crushed shadow
    // side (form gains mass; even fresnel everywhere was the AI tell). View-space
    // so the illumination stays put on screen while the specimen tumbles under it
    // (a microscope light, not a swimming spotlight). Half the form goes dark,
    // which by itself kills the muddy mid-value teal. ----
    const vec3 KEY = normalize(vec3(-0.6, 0.5, 0.28));         // upper-left, toward camera
    float kdot = dot(Np, KEY);
    float value = mix(0.08, 1.0, smoothstep(-0.45, 0.92, kdot)); // dramatic lit-cheek → shadow sweep
    value += smoothstep(0.0, -0.95, kdot) * 0.06;             // faint far-side fill (never void)

    // ---- color by VALUE-ZONE — NO hue averaging into the base (that was the
    // teal generator). Deep BLUE near-black tissue; electric uCore owns the web
    // spines + nucleolus; per-cluster multicolor is a chroma-boosted ridge tint +
    // rare jewel nodes, so it's punctuation against blue, never a rainbow shell. --
    int si = int(mod(floor(w1.z * 8.0), 8.0));
    vec3 hue = uSectorCol[si];
    float mx = max(max(hue.r, hue.g), hue.b);
    hue = mix(hue, hue / max(mx, 1e-3) * mx, 0.5);            // boost chroma, keep value
    vec3 deep = mix(uDeep, uBlue, 0.20);                      // electric-blue-shifted dark cytoplasm
    float dome = smoothstep(0.55, 0.0, w1.x);
    float sac = dome * dome;
    vec3 membrane = deep * (0.34 + 0.24 * sac);               // dark tissue + faint inner dome

    float webAmt = (edge1 * 1.5 + edge2 * 0.55 + organelle * 0.55) * (0.7 + uWork * 1.7 + uTalk * 0.7);
    vec3 web = mix(uBlue, hue, 0.38) * webAmt;                // ELECTRIC blue spine, hue-tinted ridge

    // jewel nodes — saturated gems only where both octaves coincide (rare)
    float node = pow(edge1 * edge2, 0.6) * (0.6 + 0.8 * hash13(vec3(w1.z * 91.0)));
    vec3 nodes = hue * node * (1.3 + uWork * 1.1);

    // ---- NUCLEOLUS: a granular organelle glimpsed through the front. On a shell
    // mesh the "interior seen through the centre" is the view-facing region (high
    // ndv), so it's driven by ndv — a soft halo + a tight hot kernel + chromatin
    // speckle + a dark perinucleolar ring, tone-mapped so it never clips to a
    // white blob, and occluded by the web in front so a crossing ridge darkens it
    // (depth through opaque cytoplasm). NOT key-darkened: it keeps the centre
    // luminous on the shadow side too (no 'black sphere' regression). ----
    float heat = clamp(uWork * 1.2 + uTalk * 0.55, 0.0, 1.0);
    float halo = pow(ndv, 5.5);                              // SMALL soft body toward disk centre
    float kernel = pow(ndv, 22.0);                           // very tight hot pip nested inside
    float speck = 0.6 + 0.4 * snoise(dir * 13.0 + uTime * 0.18); // chromatin grain
    float ring = smoothstep(0.40, 0.58, ndv) - smoothstep(0.58, 0.78, ndv); // perinucleolar gap
    // LINEAR emission — the single final 1-exp rolloff handles saturation, so only
    // the tiny kernel pip whitens while the halo stays electric blue (no white blob)
    float occ = (1.0 - webAmt * 0.5) * (1.0 - ring * 0.4);   // web-in-front + body boundary
    float life = 0.6 + uTalk * 0.5;
    // electric-blue body + a hot pale-white pip at the very centre (warms on work)
    vec3 haloCol = mix(uBlue, uCore, 0.30);
    vec3 kerCol = mix(uCore, uAccent, 0.4 * heat);
    vec3 nucleolus = (haloCol * halo * 0.38 * speck + kerCol * kernel * 2.2) * life * occ;

    // techy cool energy rim — now hugs each relief ridge (defines the 3D form)
    vec3 rim = uBlue * fres * 0.9;

    // R9 heat: warm only blooms on the LIT/active cheek (never an ambient pink tint)
    vec3 hot = uAccent * (edge1 * 0.8 + kernel * 0.6) * heat * smoothstep(0.0, 0.6, kdot);

    // composite: surface terms take the key sweep (the mud-killer); the nucleolus
    // is interior light, so it is NOT value-darkened. 1-exp hue-preserving rolloff
    // matches the connectome (TENDRIL/ARBOR) so firing cells keep hue, never clip.
    vec3 lin = (membrane + web + nodes) * value + rim * (value * 0.85 + 0.15) + nucleolus + hot;
    vec3 col = vec3(1.0) - exp(-lin * 1.25);                  // gentler rolloff keeps the web BLUE, not white
    // saturation lift → electric blue + jewel hues read, never silvery-grey
    float L = dot(col, vec3(0.299, 0.587, 0.114));
    col = max(mix(vec3(L), col, 1.30), 0.0);
    gl_FragColor = vec4(col, 1.0);                            // opaque occluder (alpha 1)
  }
`;

/** The neuron-nucleus core centre - opaque + depth-writing (the occluder), with
 *  a self-luminous cellular-membrane surface. Re-created on theme flip. */
export function makeNucleusMaterial(
  core: THREE.Color,
  blue: THREE.Color,
  deep: THREE.Color,
  accent: THREE.Color,
  sectorCols: Float32Array,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SNOISE + NUCLEUS_VERT,
    fragmentShader: SNOISE + WORLEY + NUCLEUS_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uBreath: { value: 0.7 },
      uTalk: { value: 0 },
      uWork: { value: 0 },
      uCore: { value: core.clone() },
      uBlue: { value: blue.clone() },
      uDeep: { value: deep.clone() },
      uAccent: { value: accent.clone() },
      uSectorCol: { value: sectorCols },
    },
    // opaque + depth-writing: this IS the occluder. No blending.
  });
}

export function makeNeuronMaterial(opts: {
  base: THREE.Color;
  emissive: THREE.Color;
  rim: THREE.Color;
  fireCool: THREE.Color;
  fireHot: THREE.Color;
}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: opts.base,
    emissive: opts.emissive,
    emissiveIntensity: 1.0,
    roughness: 0.46,
    metalness: 0.0,
  });
  const c = (col: THREE.Color) => `vec3(${col.r.toFixed(4)}, ${col.g.toFixed(4)}, ${col.b.toFixed(4)})`;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute float aGlow;
         varying float vGlow;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vGlow = aGlow;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying float vGlow;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         // FIRING: cool→hot emissive, driven per-instance (deep + near active work)
         vec3 fireCol = mix(${c(opts.fireCool)}, ${c(opts.fireHot)}, smoothstep(0.45, 1.0, vGlow));
         totalEmissiveRadiance += fireCol * vGlow * 2.6;
         // fresnel RIM — a techy energy edge on every lit neuron (reads as sheen)
         float nFres = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 3.0);
         totalEmissiveRadiance += ${c(opts.rim)} * nFres * 0.55;`,
      );
  };
  return mat;
}
