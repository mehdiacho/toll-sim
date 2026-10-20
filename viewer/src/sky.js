// Sun, sky colour, fog and stars driven by the feed's clock (Botswana, UTC+2).
import * as THREE from "three";

const LAT = (-23.6 * Math.PI) / 180; // along the corridor
const LON = 26.2;

/** Sun direction for a UTC timestamp: { elevation, azimuth } in radians. */
export function sunPosition(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const doy = (ms - start) / 86400000;
  const decl = (-23.44 * Math.PI) / 180 * Math.cos(((2 * Math.PI) / 365) * (doy + 10));
  const utcH = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const solar = utcH + LON / 15; // ignore the equation of time
  const H = ((solar - 12) * 15 * Math.PI) / 180;
  const el = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(decl) * Math.cos(LAT) - Math.sin(LAT) * Math.cos(H));
  return { elevation: el, azimuth: az }; // azimuth from north, clockwise
}

const C = (h) => new THREE.Color(h);
// sky colour keyframes by sun elevation (degrees)
const SKY = [
  [-18, C(0x05070d)],
  [-8, C(0x0c1424)],
  [-2, C(0x2a2f4a)],
  [2, C(0xd9895a)],
  [8, C(0xa9c3d9)],
  [25, C(0x8fbbe3)],
  [90, C(0x7fb2e5)],
];
const ZENITH = [
  [-18, C(0x020308)],
  [-6, C(0x060b18)],
  [0, C(0x1b2a4d)],
  [6, C(0x3f6fae)],
  [25, C(0x2f6db8)],
  [90, C(0x2a64b0)],
];
function ramp(keys, deg, out) {
  for (let i = 1; i < keys.length; i++) {
    if (deg <= keys[i][0]) {
      const [d0, c0] = keys[i - 1];
      const [d1, c1] = keys[i];
      return out.copy(c0).lerp(c1, Math.max(0, Math.min(1, (deg - d0) / (d1 - d0))));
    }
  }
  return out.copy(keys[keys.length - 1][1]);
}
function skyColor(deg, out) {
  for (let i = 1; i < SKY.length; i++) {
    if (deg <= SKY[i][0]) {
      const [d0, c0] = SKY[i - 1];
      const [d1, c1] = SKY[i];
      return out.copy(c0).lerp(c1, Math.max(0, Math.min(1, (deg - d0) / (d1 - d0))));
    }
  }
  return out.copy(SKY[SKY.length - 1][1]);
}

export class Sky {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    scene.background = new THREE.Color(0x8fbbe3);
    scene.fog = new THREE.FogExp2(0x8fbbe3, 0.0002);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x8a7350, 0.9);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -160;
    sc.right = sc.top = 160;
    sc.near = 1;
    sc.far = 3000;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.4;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.moon = new THREE.DirectionalLight(0x8ea6d6, 0.0);
    scene.add(this.moon);
    scene.add(this.moon.target);

    // stars on a big dome that follows the camera
    const n = 1400;
    const pos = new Float32Array(n * 3);
    let s = 99;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = r() * 2 - 1;
      const th = r() * Math.PI * 2;
      const y = Math.abs(u) * 0.95 + 0.05;
      const k = Math.sqrt(1 - y * y);
      pos.set([Math.cos(th) * k, y, Math.sin(th) * k], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }),
    );
    this.stars.renderOrder = -1;
    scene.add(this.stars);

    // gradient dome: horizon colour (matches the fog) up to a zenith colour
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sun: { value: new THREE.Vector3(0, 1, 0) }, glow: { value: new THREE.Color() } },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sun; uniform vec3 glow; varying vec3 vDir;
          void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 c = mix(horizon, top, pow(h, 0.55));
            float s = max(dot(normalize(vDir), normalize(sun)), 0.0); c += glow * (pow(s, 6.0) * 0.35 + pow(s, 600.0) * 1.5);
            gl_FragColor = vec4(c, 1.0); }`,
      }),
    );
    this.dome.renderOrder = -2;
    this.dome.frustumCulled = false;
    scene.add(this.dome);
    this.tmp2 = new THREE.Color();
    this.night = 0;
    this.tmp = new THREE.Color();
    this.elevationDeg = 40;
  }

  /** ms: UTC timestamp to light the scene for; focus: Vector3 to centre shadows on. */
  update(ms, focus, camera) {
    const { elevation, azimuth } = sunPosition(ms);
    const deg = (elevation * 180) / Math.PI;
    this.elevationDeg = deg;
    // direction toward the sun in scene coords (x east, -z north)
    const dir = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
    const day = THREE.MathUtils.smoothstep(deg, -4, 10);
    const night = 1 - THREE.MathUtils.smoothstep(deg, -10, 1);
    this.night = night;

    skyColor(deg, this.tmp);
    this.scene.background.copy(this.tmp);
    this.scene.fog.color.copy(this.tmp);
    const u = this.dome.material.uniforms;
    u.horizon.value.copy(this.tmp);
    ramp(ZENITH, deg, u.top.value);
    u.sun.value.copy(dir);
    u.glow.value.setRGB(1, 0.8, 0.55).multiplyScalar(THREE.MathUtils.smoothstep(deg, -6, 2));
    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(camera.far * 0.85);

    const warm = 1 - THREE.MathUtils.smoothstep(deg, 2, 22);
    this.sun.color.setRGB(1, 0.95 - warm * 0.3, 0.86 - warm * 0.45);
    this.sun.intensity = 2.4 * day;
    const d = dir.y > 0.02 ? dir : new THREE.Vector3(dir.x, 0.02, dir.z).normalize();
    this.sun.position.copy(focus).addScaledVector(d, 1200);
    this.sun.target.position.copy(focus);
    this.sun.castShadow = day > 0.2;

    this.moon.intensity = 0.9 * night;
    this.moon.position.copy(focus).add(new THREE.Vector3(-300, 900, 400));
    this.moon.target.position.copy(focus);

    this.hemi.intensity = 0.32 + 0.8 * day;
    this.hemi.color.setRGB(0.55 + 0.26 * day, 0.62 + 0.27 * day, 0.85 + 0.15 * day);
    this.hemi.groundColor.setRGB(0.12 + 0.42 * day, 0.11 + 0.34 * day, 0.12 + 0.2 * day);
    this.renderer.toneMappingExposure = 0.9 + 0.25 * day;

    this.stars.material.opacity = night * 0.9;
    this.stars.position.copy(camera.position);
    this.stars.scale.setScalar(camera.far * 0.8);
  }
}
