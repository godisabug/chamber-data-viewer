export type Diagnostic = {
  /** Stable machine-readable category. Unclassified diagnostics omit this field. */
  code?: string;
  level: "info" | "warning" | "error";
  message: string;
};

export type DataPoint = [timestamp: string, value: number | null];

export type Axis = {
  id: string;
  role: "primary" | "secondary";
  name: string;
  unit: string;
};

export type Series = {
  id: string;
  name: string;
  unit: string;
  role: "setpoint" | "measured" | "output" | "unknown";
  axisId: string;
  points: DataPoint[];
};

export type DatasetSource = {
  sourceId: string;
  sourceFile: string;
};

export type Dataset = {
  sourceId: string;
  sourceFile: string;
  sources: DatasetSource[];
  parser: string;
  controllerRule: string;
  timeRange: {
    start: string;
    end: string;
  };
  rowCount: number;
  axes: Axis[];
  series: Series[];
  diagnostics: Diagnostic[];
};
