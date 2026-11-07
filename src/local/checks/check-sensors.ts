import type { AmpleFileCheckTextSnapshot } from "./check-text.js";
import type { AmpleFileCheckRunRecord } from "./check-types.js";
import { createModelReviewSensor } from "./model-review-sensor.js";
import type { AmpleFileCheckDeclaration } from "../../shared/checks.js";
import type {
  AmpleFileCheckCandidateFinding,
  AmpleFileCheckFileIdentity,
} from "./check-types.js";

export interface AmpleFileCheckSensorInputSet {
  snapshots?: AmpleFileCheckTextSnapshot[];
  files: Array<{ path: string; sizeBytes: number }>;
  missingExactTargets: Array<{ path: string }>;
}

export interface AmpleFileCheckSensorContext {
  declaration: AmpleFileCheckDeclaration;
  /** Runner-owned closed projection. Sensors never receive filesystem paths. */
  inputs: AmpleFileCheckSensorInputSet;
  signal: AbortSignal;
}

export interface AmpleFileCheckSensorResult {
  candidates: AmpleFileCheckCandidateFinding[];
  skippedCount: number;
  cost?: AmpleFileCheckRunRecord["cost"];
}

export interface AmpleFileCheckSensor {
  id: string;
  revision: number;
  /** Digest of the exact trusted implementation behind this revision. */
  implementationDigest: string;
  execution: "deterministic" | "model";
  validate(declaration: AmpleFileCheckDeclaration): void;
  run(context: AmpleFileCheckSensorContext): Promise<AmpleFileCheckSensorResult>;
}

export const ampleFileFilePresenceSensorDigest = "3e9248674bf7dc9a09d7daa3177edff672e1288d19f75c43436d9388336f15eb";

const filePresenceSensor: AmpleFileCheckSensor = {
  id: "amplefile.file-presence",
  revision: 1,
  implementationDigest: ampleFileFilePresenceSensorDigest,
  execution: "deterministic",
  validate: validateAmpleFileFilePresence,
  run: runAmpleFileFilePresence,
};

// AMPLEFILE_FILE_PRESENCE_SENSOR_IMPLEMENTATION_START
function validateAmpleFileFilePresence(declaration: AmpleFileCheckDeclaration): void {
  const parameters = declaration.sensor.parameters;
  const keys = Object.keys(parameters);
  if (keys.length !== 1 || keys[0] !== "expect" || (parameters.expect !== "present" && parameters.expect !== "absent")) {
    throw new Error("amplefile.file-presence parameters must contain only expect: present or absent.");
  }
  if (declaration.targets.some((target) => target.kind !== "file" || target.role !== "primary")) {
    throw new Error("amplefile.file-presence accepts only exact primary file targets.");
  }
}

async function runAmpleFileFilePresence({ declaration, inputs: closedInputs, signal }: AmpleFileCheckSensorContext): Promise<AmpleFileCheckSensorResult> {
  const expect = declaration.sensor.parameters.expect as "present" | "absent";
  const files = new Map(closedInputs.files.map((file) => [file.path, file]));
  const missing = new Set(closedInputs.missingExactTargets.map((target) => target.path));
  const candidates: AmpleFileCheckCandidateFinding[] = [];
  for (const target of declaration.targets) {
    if (signal.aborted) throw new Error(String(signal.reason || "Check sensor was aborted."));
    const file = files.get(target.path);
    const observed = file ? "file" : "missing";
    if (!file && !missing.has(target.path)) throw new Error(`Resolved target is missing from the closed input set: ${target.path}`);
    const identity: AmpleFileCheckFileIdentity = {
      checkId: declaration.id,
      path: target.path,
      state: observed,
      ...(file ? { size: file.sizeBytes } : {}),
    };
    const expected = expect === "present" ? "file" : "missing";
    if (observed === expected) continue;
    candidates.push({
      title: expect === "present" ? "Expected file is missing" : "File exists but should be absent",
      detail: expect === "present"
        ? "The explicitly designated file could not be found."
        : "The explicitly designated path currently contains a file.",
      targetPath: target.path,
      evidence: [{ kind: "path-state", path: target.path, expected, observed, identity }],
    });
  }
  return { candidates, skippedCount: 0 };
}
// AMPLEFILE_FILE_PRESENCE_SENSOR_IMPLEMENTATION_END

const builtinSensors = new Map<string, AmpleFileCheckSensor>([
  [filePresenceSensor.id, filePresenceSensor],
  ["amplefile.text-review", createModelReviewSensor()],
]);

export function resolveAmpleFileCheckSensor(id: string, revision: number): AmpleFileCheckSensor | null {
  const sensor = builtinSensors.get(id) ?? null;
  return sensor?.revision === revision ? sensor : null;
}
