import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS module shared with the browser viewer
import { CLASS_INFO, frontToCentre } from "../viewer/src/vehicle-geometry.js";

const root = new URL("..", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

describe("viewer vehicle geometry", () => {
  it("draws every class at the length the sim gives it", () => {
    // ("2", "bus", 0.09, 'length="7.5" ...')
    const sim = new Map(
      [...read("sim/demand.py").matchAll(/\("(\w)",\s*"\w+",\s*[\d.]+,\s*'length="([\d.]+)"/g)].map((m) => [m[1], Number(m[2])]),
    );
    expect(sim.size).toBe(5);
    for (const [cls, len] of sim) expect(CLASS_INFO[cls]?.len, `class ${cls}`).toBe(len);
  });

  it("keeps the offline replay on the same lengths", () => {
    // ["2", 0.09, 7.5, [85, 100]],
    const replay = new Map(
      [...read("viewer/scripts/make-replay.mjs").matchAll(/\["(\w)",\s*[\d.]+,\s*([\d.]+),\s*\[/g)].map((m) => [m[1], Number(m[2])]),
    );
    expect(replay.size).toBe(5);
    for (const [cls, len] of replay) expect(CLASS_INFO[cls]?.len, `class ${cls}`).toBe(len);
  });

  it("puts the model centre half a length behind SUMO's front bumper", () => {
    const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
    // heading north (+Y): the centre is south of the bumper
    close(frontToCentre(100, 200, 0, 7.5), [100, 196.25]);
    // heading east (+X)
    close(frontToCentre(100, 200, 90, 12), [94, 200]);
    // heading south-west
    const h = 18.5 / 2 / Math.SQRT2;
    close(frontToCentre(0, 0, 225, 18.5), [h, h]);
  });
});
