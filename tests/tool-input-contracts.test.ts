import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { validateToolArguments } from "@earendil-works/pi-ai";
import test from "node:test";
import { withInputContract } from "../resources/included-tools/input-contracts.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const engines = await jiti.import<any>(new URL("../resources/included-tools/documents/engines.mjs", import.meta.url).pathname);
function declarations(factory: (api: any) => void) {
  const tools = new Map<string, any>();
  const api = new Proxy({ registerTool: (tool: any) => tools.set(tool.name, tool), events: { emit() {} } }, {
    get(target, key) { return Reflect.get(target, key) ?? (() => {}); },
  });
  factory(api);
  return tools;
}
const documentTools = declarations(api => engines.registerDocumentEngineTools(api, {}));
function validate(tool: any, args: Record<string, unknown>) {
  const nested = tool.parameters.properties.input;
  const result = validateToolArguments(tool, { name: tool.name, id: "input-fixture", type: "toolCall", arguments: nested ? { input: args } : args });
  return nested ? result.input : result;
}

test("native validation enforces each document operation before engine execution", () => {
  const tool = documentTools.get("document_engine");
  assert.equal(tool.parameters.type, "object");
  assert.equal(tool.parameters.anyOf, undefined, "OpenAI rejects function-root alternatives");
  assert.ok(tool.parameters.properties.input.anyOf.every((branch: any) => branch.type === "object"));
  assert.throws(() => validateToolArguments(tool, { name: tool.name, id: "flat", type: "toolCall", arguments: { operation: "status" } }), /input/);
  assert.deepEqual(validate(tool, { operation: "status" }), { operation: "status" });
  for (const operation of ["render", "recalculate", "ocr", "preview"]) {
    assert.throws(() => validate(tool, { operation, output: "out.txt" }), /source/);
    assert.throws(() => validate(tool, { operation, source: "input.png" }), /output/);
    assert.throws(() => validate(tool, { operation, source: "", output: "out.txt" }), /Validation failed/);
    assert.equal(validate(tool, { operation, source: "input.png", output: "out.txt" }).source, "input.png");
  }
  assert.match(tool.description, /"source":"\.worker\/task\/page.png"/);
});

test("input contracts forward exact inputs and native lifecycle arguments without repairs", () => {
  const calls: unknown[][] = [];
  const execute = (...args: unknown[]) => { calls.push(args); return "same execution"; };
  const tool = { name: "generic", description: "Generic operation", parameters: { type: "object", properties: { target: { type: "string" } } }, execute };
  const decorated = withInputContract(tool, { variants: [{ required: ["target"] }], examples: [{ target: "observed-id" }] });
  const input = { target: "observed-id" }, signal = new AbortController().signal, update = () => {}, context = { cwd: "/fixture" };
  assert.equal(decorated.execute("call-id", { input }, signal, update, context), "same execution");
  assert.deepEqual(calls, [["call-id", input, signal, update, context]]);
  assert.equal(calls[0]![1], input, "the declared input is forwarded unchanged");
  assert.deepEqual(tool.parameters, { type: "object", properties: { target: { type: "string" } } });
  assert.throws(() => withInputContract(tool, { variants: [{ required: ["unknown"] }], examples: [] }), /Unknown input field/);
});
