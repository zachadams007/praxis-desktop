/**
 * AtlasCity - the isometric task-CITY (Atlas direction).
 *
 * Tasks are extruded BUILDINGS standing in district pads on a ground plane;
 * HEIGHT encodes scope, the lit 3-face shading + cast shadows + N8AO sell the
 * volume so it reads 3D in a still frame (no orbit needed). A central light-SPIRE
 * is the orchestrator core, beaming to firing districts; cross-initiative
 * dependencies route along the ground as conduits. Camera is an isometric
 * OrthographicCamera with MapControls - pan + clamped zoom ONLY, never free orbit
 * (honors the same R2 constraint as the brain). Mobile-safe: capped DPR, a single
 * InstancedMesh for every building, half-res AO, one shadow-casting light.
 */

import { Component, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Grid, Html, Line, MapControls, OrthographicCamera } from "@react-three/drei";
import { Bloom, EffectComposer, N8AO, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { usePraxisStore } from "@/store/usePraxisStore";
import { useActivePalette } from "@/theme/useActivePalette";
import { buildCity, statusColor, type CityModel } from "./cityLayout";

// ---------------------------------------------------------------------------
// Buildings - one InstancedMesh for the whole city (mobile budget)
// ---------------------------------------------------------------------------

const Q_ID = new THREE.Quaternion();

/** Lit body color: the district hue, darkened so the directional light can shade
 *  the three faces (a fully-bright box reads flat). Done work sinks toward the
 *  structural edge color; active bodies stay a touch richer (the crown glows). */
function bodyColor(
  hue: THREE.Color,
  edge: THREE.Color,
  bg: THREE.Color,
  status: string,
): THREE.Color {
  if (status === "done") return edge.clone().lerp(bg, 0.45);
  const base = hue.clone().lerp(bg, status === "active" ? 0.32 : 0.5);
  return base;
}

function Buildings({ city }: { city: CityModel }) {
  const palette = useActivePalette();
  const ref = useRef<THREE.InstancedMesh>(null);
  const setHover = usePraxisStore((s) => s.setHover);

  const geo = useMemo(() => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0, 0.5, 0); // base sits on the ground, extrudes up
    return g;
  }, []);
  const mat = useMemo(
    () => new THREE.MeshStandardMaterial({ roughness: 0.58, metalness: 0.08, envMapIntensity: 0.4 }),
    [],
  );
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const edge = new THREE.Color(palette.edge);
    const bg = new THREE.Color(palette.bg);
    city.buildings.forEach((b, i) => {
      p.set(b.pos[0], 0, b.pos[2]);
      s.set(b.footprint * 2, b.height, b.footprint * 2);
      m.compose(p, Q_ID, s);
      mesh.setMatrixAt(i, m);
      const dHue = new THREE.Color(city.byDistrict.get(b.areaId)?.hue ?? palette.baseCool);
      mesh.setColorAt(i, bodyColor(dHue, edge, bg, b.status));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [city, palette]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const id = e.instanceId;
    if (id == null) return;
    usePraxisStore.getState().focus(city.buildings[id].taskId);
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const id = e.instanceId;
    setHover(id != null ? city.buildings[id].taskId : null);
    document.body.style.cursor = id != null ? "pointer" : "auto";
  };
  const onOut = () => {
    setHover(null);
    document.body.style.cursor = "auto";
  };

  return (
    <instancedMesh
      ref={ref}
      args={[geo, mat, city.buildings.length]}
      castShadow
      receiveShadow
      onClick={onClick}
      onPointerMove={onMove}
      onPointerOut={onOut}
    />
  );
}

/** Glowing crowns on FIRING (active) buildings - the only emissive caps, so the
 *  bloom pass lights exactly the work that's live. */
function Crowns({ city }: { city: CityModel }) {
  const palette = useActivePalette();
  const ref = useRef<THREE.InstancedMesh>(null);
  const active = useMemo(() => city.buildings.filter((b) => b.status === "active"), [city]);

  const geo = useMemo(() => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0, 0.5, 0);
    return g;
  }, []);
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(palette.accent).multiplyScalar(1.6),
        toneMapped: false,
      }),
    [palette],
  );
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh || active.length === 0) return;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    active.forEach((b, i) => {
      p.set(b.pos[0], b.height, b.pos[2]);
      s.set(b.footprint * 2.05, 0.22, b.footprint * 2.05);
      m.compose(p, Q_ID, s);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [active]);

  // gentle pulse so live work breathes (reduced-motion → steady)
  const reduce = usePrefersReducedMotion();
  useFrame((st) => {
    if (reduce || !ref.current) return;
    const k = 1.3 + Math.sin(st.clock.elapsedTime * 2.2) * 0.4;
    (ref.current.material as THREE.MeshBasicMaterial).color
      .set(palette.accent)
      .multiplyScalar(k);
  });

  if (active.length === 0) return null;
  return <instancedMesh ref={ref} args={[geo, mat, active.length]} frustumCulled={false} />;
}

// ---------------------------------------------------------------------------
// District pads + floating name tabs
// ---------------------------------------------------------------------------

function Districts({ city }: { city: CityModel }) {
  const palette = useActivePalette();
  const focusId = usePraxisStore((s) => s.focusId);
  const activeArea = useMemo(() => {
    if (!focusId) return null;
    return city.byTask.get(focusId)?.areaId ?? (city.byDistrict.has(focusId) ? focusId : null);
  }, [focusId, city]);

  return (
    <group>
      {city.districts.map((d) => {
        const on = activeArea === d.id;
        return (
          <group key={d.id} position={[d.center[0], 0, d.center[1]]}>
            {/* pad - a thin rounded slab, hue-rimmed; lifts + brightens when focused */}
            <mesh
              position={[0, 0.015, 0]}
              rotation={[-Math.PI / 2, 0, 0]}
              receiveShadow
              onClick={(e) => {
                e.stopPropagation();
                usePraxisStore.getState().focus(d.id);
              }}
            >
              <planeGeometry args={[d.pad[0] * 2 + 1.2, d.pad[1] * 2 + 1.2]} />
              <meshStandardMaterial
                color={new THREE.Color(d.hue).lerp(new THREE.Color(palette.bg), on ? 0.72 : 0.86)}
                roughness={0.85}
                metalness={0.0}
                transparent
                opacity={on ? 0.95 : 0.7}
              />
            </mesh>
            {/* hue edge frame */}
            <Line
              points={padFrame(d.pad[0] + 0.6, d.pad[1] + 0.6)}
              color={d.hue}
              lineWidth={on ? 2.4 : 1.2}
              transparent
              opacity={on ? 0.95 : 0.5}
              position={[0, 0.05, 0]}
            />
            {/* floating district tab */}
            <Html position={[0, 2.0, 0]} center occlude={false} zIndexRange={[20, 0]}>
              <div className={`atlas-tab ${on ? "atlas-tab-on" : ""}`} style={{ "--hue": d.hue } as React.CSSProperties}>
                <span className="atlas-tab-dot" />
                <span className="atlas-tab-name">{d.label}</span>
                <span className="atlas-tab-count">{d.taskIds.length}</span>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

/** Closed rectangle outline (XZ plane) for a pad frame. */
function padFrame(hx: number, hz: number): [number, number, number][] {
  return [
    [-hx, 0, -hz],
    [hx, 0, -hz],
    [hx, 0, hz],
    [-hx, 0, hz],
    [-hx, 0, -hz],
  ];
}

// ---------------------------------------------------------------------------
// Core spire + beams to firing districts
// ---------------------------------------------------------------------------

function CoreSpire({ city }: { city: CityModel }) {
  const palette = useActivePalette();
  const reduce = usePrefersReducedMotion();
  const apexRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const SPIRE_H = 8.5;

  const firing = useMemo(() => city.districts.filter((d) => d.firing), [city]);

  useFrame((st) => {
    if (reduce) return;
    const t = st.clock.elapsedTime;
    if (apexRef.current) apexRef.current.scale.setScalar(1 + Math.sin(t * 1.6) * 0.08);
    if (haloRef.current) haloRef.current.rotation.z = t * 0.25;
  });

  const hub = palette.hub;
  const accent = palette.accent;

  return (
    <group>
      {/* ground halo */}
      <mesh ref={haloRef} position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.7, 3.4, 48]} />
        <meshBasicMaterial color={hub} transparent opacity={0.12} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      {/* tapered shaft - additive light column */}
      <mesh position={[0, SPIRE_H / 2, 0]}>
        <cylinderGeometry args={[0.16, 0.7, SPIRE_H, 24, 1, true]} />
        <meshBasicMaterial
          color={hub}
          transparent
          opacity={0.5}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      {/* inner bright core */}
      <mesh position={[0, SPIRE_H / 2, 0]}>
        <cylinderGeometry args={[0.07, 0.16, SPIRE_H, 16]} />
        <meshBasicMaterial color={hub} toneMapped={false} />
      </mesh>
      {/* apex glow (bloom anchor) */}
      <mesh ref={apexRef} position={[0, SPIRE_H + 0.2, 0]}>
        <sphereGeometry args={[0.55, 20, 20]} />
        <meshBasicMaterial color={hub} toneMapped={false} />
      </mesh>
      {/* beams to firing districts */}
      {firing.map((d) => (
        <Line
          key={d.id}
          points={[
            [0, SPIRE_H + 0.1, 0],
            [d.center[0], 1.4, d.center[1]],
          ]}
          color={accent}
          lineWidth={1.4}
          transparent
          opacity={0.5}
          dashed
          dashSize={0.7}
          gapSize={0.5}
        />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Ground-routed dependency conduits
// ---------------------------------------------------------------------------

function Conduits({ city }: { city: CityModel }) {
  const palette = useActivePalette();
  return (
    <group>
      {city.conduits.map((c) => (
        <Line
          key={c.id}
          points={c.points}
          color={new THREE.Color(palette.baseWarm).lerp(new THREE.Color(palette.bg), 0.1)}
          lineWidth={1.6}
          transparent
          opacity={0.42}
          dashed={c.kind === "related"}
          dashSize={0.6}
          gapSize={0.4}
        />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Ground plane + tech grid
// ---------------------------------------------------------------------------

function Ground() {
  const palette = useActivePalette();
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color={new THREE.Color(palette.bgDeep)} roughness={1} metalness={0} />
      </mesh>
      <Grid
        position={[0, 0.012, 0]}
        infiniteGrid
        cellSize={2.55}
        cellThickness={0.6}
        cellColor={new THREE.Color(palette.line)}
        sectionSize={12.75}
        sectionThickness={1.1}
        sectionColor={new THREE.Color(palette.baseCool).lerp(new THREE.Color(palette.bg), 0.55)}
        fadeDistance={120}
        fadeStrength={3}
        followCamera={false}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Camera focus - soft pan/zoom to the focused district (no orbit)
// ---------------------------------------------------------------------------

function CameraFocus({ city }: { city: CityModel }) {
  const focusId = usePraxisStore((s) => s.focusId);
  const focusNonce = usePraxisStore((s) => s.focusNonce);
  const controls = useThree((st) => st.controls) as unknown as { target: THREE.Vector3 } | null;
  const cam = useThree((st) => st.camera) as THREE.OrthographicCamera;

  const goal = useRef({ target: new THREE.Vector3(0, 1.5, 0), zoom: 29 });
  const reduce = usePrefersReducedMotion();

  useEffect(() => {
    const t = goal.current.target;
    if (!focusId) {
      t.set(0, 1.5, 0);
      goal.current.zoom = 29;
      return;
    }
    const d = city.byTask.get(focusId)
      ? city.byDistrict.get(city.byTask.get(focusId)!.areaId)
      : city.byDistrict.get(focusId);
    if (d) {
      t.set(d.center[0], 1.5, d.center[1]);
      goal.current.zoom = 44;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusNonce, city]);

  useFrame(() => {
    if (!controls) return;
    const g = goal.current;
    const k = reduce ? 1 : 0.08;
    const prev = controls.target.clone();
    controls.target.lerp(g.target, k);
    // move the camera by the same delta so panning never rotates the iso view
    cam.position.add(controls.target.clone().sub(prev));
    const nz = cam.zoom + (g.zoom - cam.zoom) * k;
    if (Math.abs(nz - cam.zoom) > 1e-3) {
      cam.zoom = nz;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

class FxBoundary extends Component<{ children: ReactNode }, { dead: boolean }> {
  state = { dead: false };
  static getDerivedStateFromError() { return { dead: true }; }
  render() { return this.state.dead ? null : this.props.children; }
}

function AtlasEffects() {
  const palette = useActivePalette();
  return (
    <FxBoundary>
      <EffectComposer multisampling={4}>
        <N8AO halfRes aoRadius={1.5} distanceFalloff={1.0} intensity={2.6} quality="low" color={palette.bgDeep} />
        <Bloom
          intensity={palette.bloom * 0.85}
          luminanceThreshold={0.55}
          luminanceSmoothing={0.4}
          mipmapBlur
          radius={0.6}
        />
        <Vignette eskil={false} offset={0.3} darkness={0.72} />
      </EffectComposer>
    </FxBoundary>
  );
}

// ---------------------------------------------------------------------------
// small shared hook
// ---------------------------------------------------------------------------

function usePrefersReducedMotion(): boolean {
  return useMemo(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );
}

// ---------------------------------------------------------------------------
// Scene + Canvas host
// ---------------------------------------------------------------------------

function Scene({ city }: { city: CityModel }) {
  const palette = useActivePalette();
  return (
    <>
      <color attach="background" args={[palette.bg]} />
      <fog attach="fog" args={[palette.bg, 70, 180]} />

      <OrthographicCamera makeDefault position={[34, 30, 34]} zoom={29} near={-200} far={400} />
      <MapControls
        makeDefault
        enableRotate={false}
        enableDamping
        dampingFactor={0.12}
        screenSpacePanning={false}
        minZoom={16}
        maxZoom={58}
        target={[0, 1.5, 0]}
      />

      {/* key light casts the iso shadows; hemi + ambient fill the dark faces */}
      <ambientLight intensity={0.34} />
      <hemisphereLight
        intensity={0.45}
        color={new THREE.Color(palette.baseCool)}
        groundColor={new THREE.Color(palette.bgDeep)}
      />
      <directionalLight
        position={[20, 30, 14]}
        intensity={1.7}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      >
        <orthographicCamera attach="shadow-camera" args={[-30, 30, 30, -30, 1, 90]} />
      </directionalLight>
      {/* cool rim from the opposite side, no shadow */}
      <directionalLight position={[-18, 14, -12]} intensity={0.4} color={new THREE.Color(palette.baseWarm)} />

      <Ground />
      <Conduits city={city} />
      <Districts city={city} />
      <Buildings city={city} />
      <Crowns city={city} />
      <CoreSpire city={city} />
      <CameraFocus city={city} />
      <AtlasEffects />
    </>
  );
}

export function AtlasCity() {
  const palette = useActivePalette();
  const city = useMemo(() => buildCity(palette), [palette]);

  return (
    <Canvas
      className="atlas-canvas"
      shadows
      dpr={[1, 2]}
      gl={{ antialias: false, powerPreference: "high-performance", alpha: false }}
      onPointerMissed={() => usePraxisStore.getState().focus(null)}
    >
      <Scene city={city} />
    </Canvas>
  );
}
