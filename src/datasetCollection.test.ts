import { describe, expect, it } from "vitest";
import { mergeDataset, moveDataset, removeDataset } from "./datasetCollection";
import { makeDataset } from "./test/fixtures";

describe("dataset collection", () => {
  it("refreshes a Windows path without changing its list position", () => {
    const first = makeDataset({ sourceId: "c:/data/a.csv", sourceFile: "a.csv", rowCount: 2 });
    const second = makeDataset({ sourceId: "c:/data/b.csv", sourceFile: "b.csv" });
    const refreshed = makeDataset({ sourceId: "C:/DATA/A.CSV", sourceFile: "a.csv", rowCount: 3 });
    expect(mergeDataset([first, second], refreshed).map((item) => item.rowCount)).toEqual([3, 2]);
  });
  it("keeps same-named files from different directories", () => {
    const left = makeDataset({ sourceId: "c:/left/sample.csv", sourceFile: "sample.csv" });
    const right = makeDataset({ sourceId: "c:/right/sample.csv", sourceFile: "sample.csv" });
    expect(mergeDataset([left], right)).toEqual([left, right]);
  });
  it("replaces in place and removes an already-open duplicate", () => {
    const first = makeDataset({ sourceId: "c:/data/a.csv", sourceFile: "a.csv" });
    const second = makeDataset({ sourceId: "c:/data/b.csv", sourceFile: "b.csv" });
    expect(mergeDataset([first, second], second, first.sourceId)).toEqual([second]);
  });
  it("accounts for an earlier duplicate when replacing in place", () => {
    const duplicate = makeDataset({ sourceId: "c:/data/b.csv", sourceFile: "b.csv", rowCount: 2 });
    const replaced = makeDataset({ sourceId: "c:/data/a.csv", sourceFile: "a.csv" });
    const survivor = makeDataset({ sourceId: "c:/data/c.csv", sourceFile: "c.csv" });
    const loaded = makeDataset({ sourceId: "C:/DATA/B.CSV", sourceFile: "b.csv", rowCount: 3 });
    const result = mergeDataset([duplicate, replaced, survivor], loaded, replaced.sourceId);
    expect(result).toEqual([loaded, survivor]);
    expect(result[1]).toBe(survivor);
  });
  it("moves activity to the adjacent item and clears the final item", () => {
    const first = makeDataset({ sourceId: "c:/data/a.csv" });
    const second = makeDataset({ sourceId: "c:/data/b.csv" });
    expect(removeDataset([first, second], first.sourceId, first.sourceId).activeSourceId).toBe(second.sourceId);
    expect(removeDataset([first], first.sourceId, first.sourceId)).toEqual({ datasets: [], activeSourceId: null });
  });
  it("keeps null activity when the deleted source is missing", () => {
    const first = makeDataset({ sourceId: "c:/data/a.csv" });
    const second = makeDataset({ sourceId: "c:/data/b.csv" });
    expect(removeDataset([first, second], "c:/data/missing.csv", null)).toEqual({ datasets: [first, second], activeSourceId: null });
  });
  it("keeps null activity when deleting an inactive source", () => {
    const first = makeDataset({ sourceId: "c:/data/a.csv" });
    const second = makeDataset({ sourceId: "c:/data/b.csv" });
    expect(removeDataset([first, second], second.sourceId, null)).toEqual({ datasets: [first], activeSourceId: null });
  });
  it("clears a missing active source after a valid deletion", () => {
    const first = makeDataset({ sourceId: "c:/data/a.csv" });
    const second = makeDataset({ sourceId: "c:/data/b.csv" });
    expect(removeDataset([first, second], second.sourceId, "c:/data/missing.csv")).toEqual({ datasets: [first], activeSourceId: null });
  });
  it("moves a card to the target position and keeps every identity", () => {
    const first = makeDataset({ sourceId: "c:/data/a.csv" });
    const second = makeDataset({ sourceId: "c:/data/b.csv" });
    const third = makeDataset({ sourceId: "c:/data/c.csv" });
    expect(moveDataset([first, second, third], first.sourceId, third.sourceId)).toEqual([
      second,
      third,
      first,
    ]);
    expect(moveDataset([first, second, third], third.sourceId, first.sourceId)).toEqual([
      third,
      first,
      second,
    ]);
  });
  it("is a no-op for unknown, same, or case-insensitive identical targets", () => {
    const first = makeDataset({ sourceId: "c:/data/a.csv" });
    const second = makeDataset({ sourceId: "c:/data/b.csv" });
    expect(moveDataset([first, second], "c:/data/missing.csv", second.sourceId)).toEqual([
      first,
      second,
    ]);
    expect(moveDataset([first, second], first.sourceId, first.sourceId)).toEqual([first, second]);
    expect(moveDataset([first, second], first.sourceId, "C:/DATA/A.CSV")).toEqual([first, second]);
  });
});
