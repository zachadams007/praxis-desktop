/**
 * JourneyChrome - the quiet stage furniture of journey (tree) mode: a thin ring
 * around the root marking NOW, a faint vertical NOW axis dropped through the lane
 * stack (so the past-left / future-right symmetry reads at a glance), and a small
 * label beneath it. It only exists as the tree forms (opacity rides the morph),
 * so brain mode is untouched. Transforms/opacity only.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { useRuntime, useThemeColors } from "./context";

const RING_R = 5.4;
// the NOW axis - a quiet vertical line at x=0 through the whole lane stack, so
// the core reads as NOW with completed work to its left and upcoming to its right
const NOW_TOP = 23;
const NOW_BOT = -29;

type TroikaText = THREE.Object3D & { fillOpacity: number };

export function JourneyChrome() {
  const rt = useRuntime();
  const colors = useThemeColors();
  const ringRef = useRef<THREE.LineLoop>(null);
  const tickRef = useRef<THREE.LineSegments>(null);
  const nowRef = useRef<THREE.LineSegments>(null);
  const textRef = useRef<TroikaText | null>(null);

  const ringGeo = useMemo(() => {
    const seg = 120;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * RING_R, Math.sin(a) * RING_R, 0));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);

  // four compass ticks on the ring (the instrument read)
  const tickGeo = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      pts.push(
        new THREE.Vector3(Math.cos(a) * RING_R, Math.sin(a) * RING_R, 0),
        new THREE.Vector3(Math.cos(a) * (RING_R + 0.9), Math.sin(a) * (RING_R + 0.9), 0),
      );
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return g;
  }, []);

  // the vertical NOW axis (one segment through the lane stack, just behind it)
  const nowGeo = useMemo(
    () =>
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, NOW_TOP, -1),
        new THREE.Vector3(0, NOW_BOT, -1),
      ]),
    [],
  );

  const mat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: colors.baseCool,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [colors],
  );

  // the NOW axis rides dimmer than the ring - a quiet guide, not a hard divider
  const nowMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: colors.baseCool,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [colors],
  );

  // theme flips rebuild the material - release the old one
  useEffect(() => () => mat.dispose(), [mat]);
  useEffect(() => () => nowMat.dispose(), [nowMat]);
  useEffect(
    () => () => {
      ringGeo.dispose();
      tickGeo.dispose();
      nowGeo.dispose();
    },
    [ringGeo, tickGeo, nowGeo],
  );

  useFrame((state) => {
    rt.tick(state);
    const jm = rt.morph;
    const visible = jm > 0.02;
    if (ringRef.current) ringRef.current.visible = visible;
    if (tickRef.current) tickRef.current.visible = visible;
    if (nowRef.current) nowRef.current.visible = visible;
    mat.opacity = 0.34 * jm;
    nowMat.opacity = 0.16 * jm;
    if (textRef.current) {
      textRef.current.visible = visible;
      textRef.current.fillOpacity = 0.85 * jm;
    }
  });

  return (
    <group>
      <lineSegments ref={nowRef} geometry={nowGeo} material={nowMat} frustumCulled={false} />
      <lineLoop ref={ringRef} geometry={ringGeo} material={mat} frustumCulled={false} />
      <lineSegments ref={tickRef} geometry={tickGeo} material={mat} frustumCulled={false} />
      <Text
        ref={(r) => (textRef.current = r as unknown as TroikaText)}
        font="/fonts/praxis.ttf"
        position={[0, -RING_R - 1.7, 0]}
        fontSize={0.9}
        color={colors.palette.textDim}
        anchorX="center"
        anchorY="top"
        material-toneMapped={false}
        material-depthTest={false}
        material-transparent
        renderOrder={20}
        letterSpacing={0.22}
      >
        NOW
      </Text>
    </group>
  );
}
