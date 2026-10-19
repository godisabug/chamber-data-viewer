import type { Dataset } from "../types";

export function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  const sourceId = overrides.sourceId ?? "c:/fixtures/sample.csv";
  const sourceFile = overrides.sourceFile ?? "sample.csv";

  return {
    sourceId,
    sourceFile,
    sources: overrides.sources ?? [{ sourceId, sourceFile }],
    parser: "generic-csv",
    controllerRule: "csv-standard-v1",
    timeRange: { start: "2026-01-01 00:00:00", end: "2026-01-01 00:10:00" },
    rowCount: 2,
    diagnostics: [],
    axes: [
      { id: "primary", role: "primary", name: "温度", unit: "degC" },
      { id: "secondary", role: "secondary", name: "湿度", unit: "%RH" },
    ],
    series: [
      { id: "set-temp", name: "设定温度", unit: "degC", role: "setpoint", axisId: "primary", points: [["2026-01-01 00:00:00", 25], ["2026-01-01 00:10:00", 25]] },
      { id: "actual-temp", name: "实测温度", unit: "degC", role: "measured", axisId: "primary", points: [["2026-01-01 00:00:00", 24], ["2026-01-01 00:10:00", 25]] },
      { id: "set-humidity", name: "设定湿度", unit: "%RH", role: "setpoint", axisId: "secondary", points: [["2026-01-01 00:00:00", 60], ["2026-01-01 00:10:00", 60]] },
      { id: "actual-humidity", name: "实测湿度", unit: "%RH", role: "measured", axisId: "secondary", points: [["2026-01-01 00:00:00", 58], ["2026-01-01 00:10:00", 59]] },
    ],
    ...overrides,
  };
}
