// Vehicle sizes and the feed-to-model placement, kept free of three.js so the
// tests can check them against the sim.

// Lengths match the vTypes in sim/demand.py (test/viewer-geometry.test.ts
// keeps them in step), so the drawn bodies fill exactly the gap SUMO leaves.
export const CLASS_INFO = {
  M: { name: "Motorcycle", len: 2.2, color: "#e0564f" },
  1: { name: "Car", len: 4.6, color: "#e8edf3" },
  2: { name: "Bus", len: 7.5, color: "#f5b83d" },
  3: { name: "Truck", len: 12, color: "#75aadb" },
  4: { name: "Trailer truck", len: 18.5, color: "#9b8cf0" },
};

export function classLen(cls) {
  return CLASS_INFO[cls]?.len ?? CLASS_INFO[1].len;
}

/**
 * SUMO reports a vehicle's front bumper, but the models are centred on their
 * own origin. Step back half a length against the heading (degrees clockwise
 * from +Y, SUMO's convention) to get the centre.
 */
export function frontToCentre(X, Y, headingDeg, len) {
  const a = (headingDeg * Math.PI) / 180;
  const h = len / 2;
  return [X - Math.sin(a) * h, Y - Math.cos(a) * h];
}
