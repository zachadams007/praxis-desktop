/**
 * GroundField - the receding 3D SPACE the connectome floats in (the C-hybrid
 * depth, 2026-06-16). The brain map is a vertical radial plane in a flat void
 * today; this seats it in a world: a vast faint grid FLOOR far below that recedes
 * to a hazy horizon under the fixed 12° downtilt, plus a soft horizon ATMOSPHERE
 * gradient behind everything. Both are dim and unregistered for bloom, so they
 * add depth without competing with the neurons. Pure additive depth cues - no
 * decorative particles (R9): the grid and horizon are STRUCTURE, not noise.
 */

import { useEffect, useMemo } from "react";
import { Grid } from "@react-three/drei";
import * as THREE from "three";
import { useThemeColors } from "./context";

const GROUND_Y = -33; // below the deepest map nodes (medallions/leaves reach ~ -30)

const BACKDROP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// vertical atmosphere: deep void top + bottom with a soft luminous band at the
// horizon line, so the far distance reads as lit air rather than flat black.
const BACKDROP_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uBottom;
  uniform vec3 uHorizon;
  uniform vec3 uTop;
  uniform float uH;     // horizon position in uv.y
  uniform float uBand;  // glow band half-width
  varying vec2 vUv;
  void main() {
    float y = vUv.y;
    vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, y));
    float glow = exp(-pow((y - uH) / uBand, 2.0));
    col += uHorizon * glow;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function GroundField() {
  const colors = useThemeColors();

  const backdropMat = useMemo(() => {
    const horizon = colors.baseCool.clone().lerp(colors.bg, 0.55).multiplyScalar(0.6);
    return new THREE.ShaderMaterial({
      vertexShader: BACKDROP_VERT,
      fragmentShader: BACKDROP_FRAG,
      uniforms: {
        uBottom: { value: colors.bg.clone().lerp(new THREE.Color("#000000"), 0.4) },
        uHorizon: { value: horizon },
        uTop: { value: colors.bg.clone() },
        uH: { value: 0.46 },
        uBand: { value: 0.16 },
      },
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
  }, [colors]);
  useEffect(() => () => backdropMat.dispose(), [backdropMat]);

  const cellColor = useMemo(() => colors.edge.clone().lerp(colors.bg, 0.35), [colors]);
  const sectionColor = useMemo(() => colors.baseCool.clone().lerp(colors.bg, 0.5), [colors]);

  return (
    <group>
      {/* horizon atmosphere - drawn first, behind the whole scene */}
      <mesh material={backdropMat} position={[0, 6, -105]} renderOrder={-20} frustumCulled={false}>
        <planeGeometry args={[460, 240]} />
      </mesh>

      {/* receding grid floor - fades into the scene fog toward the horizon */}
      <Grid
        position={[0, GROUND_Y, -6]}
        args={[10, 10]}
        infiniteGrid
        cellSize={4}
        cellThickness={0.5}
        cellColor={cellColor}
        sectionSize={20}
        sectionThickness={1}
        sectionColor={sectionColor}
        fadeDistance={150}
        fadeStrength={2.2}
        followCamera={false}
      />
    </group>
  );
}
