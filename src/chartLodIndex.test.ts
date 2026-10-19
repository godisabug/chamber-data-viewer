import { describe, expect, it } from "vitest";
import { selectLodPoints } from "./chartLod";
import {
  prepareSeriesLodIndex,
  seriesLodIndexByteLength,
  summarizeIndexedRange,
} from "./chartLodIndex";
import type { PreparedPoint } from "./chartSeries";

function bruteSummary(points: PreparedPoint[], from: number, to: number) {
  const numeric = Array.from(
    { length: to - from },
    (_, offset) => from + offset,
  ).filter((index) => points[index][1] !== null);
  const preferred = (mode: "min" | "max") =>
    numeric.reduce((best, index) => {
      if (best < 0) return index;
      const value = points[index][1]!;
      const bestValue = points[best][1]!;
      if (value === bestValue) return Math.min(best, index);
      return mode === "min"
        ? value < bestValue
          ? index
          : best
        : value > bestValue
          ? index
          : best;
    }, -1);
  return {
    firstIndex: numeric[0] ?? -1,
    lastIndex: numeric.at(-1) ?? -1,
    minIndex: preferred("min"),
    maxIndex: preferred("max"),
  };
}

describe("chart LOD query index", () => {
  it("matches a deterministic scan oracle for nulls, ties, and arbitrary ranges", () => {
    let seed = 0x7f4a7c15;
    const random = () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const points = Array.from({ length: 513 }, (_, index) => {
      const value = random() < 0.22 ? null : Math.floor(random() * 17) - 8;
      return [index * index + index, value] as PreparedPoint;
    });
    const index = prepareSeriesLodIndex(points);

    for (let iteration = 0; iteration < 300; iteration += 1) {
      const from = Math.floor(random() * points.length);
      const to = from + 1 + Math.floor(random() * (points.length - from));
      expect(summarizeIndexedRange(points, index, from, to)).toEqual(
        bruteSummary(points, from, to),
      );
    }
  });

  it("keeps aggregate memory within the documented linear bound", () => {
    const points = Array.from(
      { length: 100_000 },
      (_, index) => [index, index % 2 === 0 ? index : null] as PreparedPoint,
    );
    const index = prepareSeriesLodIndex(points);

    expect(seriesLodIndexByteLength(index)).toBeLessThanOrEqual(
      points.length * 12 + 4_096,
    );
  });

  it("keeps same-width query reads nearly independent of source length", () => {
    const queryReads = (pointCount: number) => {
      const points = Array.from(
        { length: pointCount },
        (_, index) => [index, Math.sin(index / 11)] as PreparedPoint,
      );
      prepareSeriesLodIndex(points);
      let reads = 0;
      for (let index = 0; index < points.length; index += 1) {
        points[index] = new Proxy(points[index], {
          get(target, property, receiver) {
            if (property === "0" || property === "1") reads += 1;
            return Reflect.get(target, property, receiver);
          },
        });
      }
      selectLodPoints(
        points,
        { start: 0, end: pointCount - 1 },
        942,
        "settled",
      );
      return reads;
    };

    const smallReads = queryReads(50_000);
    const largeReads = queryReads(500_000);
    expect(largeReads).toBeLessThan(smallReads * 2);
  });
});
