ObjC.import("Foundation");
ObjC.import("stdlib");

var ACT_UNAVAILABLE_MESSAGE = "Open AmpleFile to run this command. Act commands need the AmpleFile app running.";
var ACT_MAX_MESSAGE_FILE_BYTES = 16777216;
var MAX_WAIT_SECONDS = 2592000;

function run(rawArguments) {
  const argumentsList = Array.from(rawArguments);
  const scriptDirectory = argumentsList.shift();
  const fileManager = $.NSFileManager.defaultManager;
  let exitCode = 1;

  try {
    const configuredAppPath = environmentValue("AMPLEFILE_CLI_APP");
    const bundledAppPaths = [
      `${scriptDirectory}/../MacOS/AmpleFile`,
      `${scriptDirectory}/../MacOS/AmpleFile Local Smoke`,
    ];
    const appPath = configuredAppPath || bundledAppPaths.find((path) => fileManager.fileExistsAtPath($(path))) || bundledAppPaths[0];
    if (!fileManager.fileExistsAtPath($(appPath))) {
      throw new Error(`AmpleFile executable was not found at ${appPath}.`);
    }

    const homeDirectory = environmentValue("HOME") || ObjC.unwrap($.NSHomeDirectory());
    const configuredStateRoot = environmentValue("AMPLEFILE_CLI_STATE_DIR");
    const defaultStateName = appPath.endsWith("/AmpleFile Local Smoke") ? "AmpleFile Local Smoke" : "AmpleFile";
    const stateRoot = configuredStateRoot || `${homeDirectory}/Library/Application Support/${defaultStateName}`;
    const cliRoot = `${stateRoot}/cli`;
    createDirectory(`${cliRoot}/requests`);
    createDirectory(`${cliRoot}/responses`);

    const timeoutValue = environmentValue("AMPLEFILE_CLI_TIMEOUT_MS");
    const timeoutMs = timeoutValue ? Number(timeoutValue) : 1800000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) {
      throw new Error("AMPLEFILE_CLI_TIMEOUT_MS must be an integer of at least 100.");
    }

    const context = { fileManager, appPath, cliRoot, timeoutMs };

    if (isActCommand(argumentsList)) {
      // Every act family other than the content-free reads rides the
      // separately versioned act lane and requires the per-launch token the
      // running app minted.
      const actToken = readActToken(cliRoot);
      if (!actToken) {
        writeHandle($.NSFileHandle.fileHandleWithStandardError, `AmpleFile: ${ACT_UNAVAILABLE_MESSAGE}\n`);
        $.exit(6);
      }
      const waitPlan = parseWaitCommand(argumentsList);
      const automationWaitPlan = waitPlan ? null : parseAutomationWaitCommand(argumentsList);
      if (waitPlan) {
        exitCode = runWaitLoop(context, waitPlan, actToken);
      } else if (automationWaitPlan) {
        exitCode = runAutomationWaitLoop(context, automationWaitPlan, actToken);
      } else {
        const prepared = prepareActArguments(argumentsList);
        const outcome = performRequest(context, prepared.argv, actToken, prepared.payload, prepared.requestId);
        emitOutcome(outcome);
        exitCode = outcome.exitCode;
      }
    } else {
      const outcome = performRequest(context, argumentsList, null, null);
      emitOutcome(outcome);
      exitCode = outcome.exitCode;
    }
  } catch (error) {
    if (error && typeof error.exitCode === "number") exitCode = error.exitCode;
    writeHandle($.NSFileHandle.fileHandleWithStandardError, `AmpleFile: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  $.exit(exitCode);
}

/** Leading positionals decide the lane; content-bearing act reads (status, result, search) are act-lane too. */
function isActCommand(argumentsList) {
  // Help for any family is content-free and works without the app running.
  if (argumentsList.includes("--help") || argumentsList.includes("-h")) return false;
  const positional = argumentsList.filter((token) => token !== "--json");
  const group = positional[0] || "";
  const actGroups = ["chat", "chats", "files", "agent", "history", "search", "tools", "automations", "recently-deleted", "requests", "jobs", "worktrees", "receipts"];
  if (actGroups.includes(group)) return true;
  return group === "connected-folders" && positional[1] !== "list";
}

function parseWaitCommand(argumentsList) {
  const positional = argumentsList.filter((token) => token !== "--json");
  const group = positional[0];
  if ((group !== "chat" && group !== "agent") || positional[1] !== "wait") return null;
  const json = argumentsList.includes("--json");
  let connectedFolder = "";
  let task = "";
  let timeoutSeconds = 3600;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (token === "--connected-folder") { connectedFolder = argumentsList[index + 1] || ""; index += 1; }
    else if (token === "--task") { task = argumentsList[index + 1] || ""; index += 1; }
    else if (token === "--timeout") {
      timeoutSeconds = Number(argumentsList[index + 1]);
      index += 1;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_WAIT_SECONDS) {
        throw usageFailure(`--timeout must be an integer between 1 and ${MAX_WAIT_SECONDS} seconds.`);
      }
    } else if (token === group || token === "wait" || token === "--json") {
      // command tokens
    } else {
      throw usageFailure(`Unknown option for ${group} wait: ${token}`);
    }
  }
  if (group === "chat" && !connectedFolder) throw usageFailure("Act commands require an explicit --connected-folder <id-or-name>.");
  if (group === "agent" && connectedFolder) throw usageFailure("The AmpleFile Agent sits above Connected Folders, so 'agent wait' takes no --connected-folder.");
  if (!task) throw usageFailure(`Provide --task <id> from ${group} send.`);
  return { group, connectedFolder, task, timeoutSeconds, json };
}

function runWaitLoop(context, plan, actToken) {
  // The task id pins a request; follow its later turns as well, so an
  // earlier reply can never read as completion of outstanding work.
  // The loop settles on two things and says which: the turn reached a
  // terminal state (then the result is printed), or the task is waiting on
  // an answer (then the status document with its `waiting` field is
  // printed, exit 0). A parent never sits on a child's question.
  const scopeArgv = plan.group === "chat" ? ["--connected-folder", plan.connectedFolder] : [];
  const statusArgv = [plan.group, "status"].concat(scopeArgv, ["--task", plan.task, "--json"]);
  const deadline = Date.now() + plan.timeoutSeconds * 1000;
  for (;;) {
    const status = performRequest(context, statusArgv, actToken, null);
    if (status.exitCode !== 0) {
      emitOutcome(status);
      return status.exitCode;
    }
    let state = "";
    let waiting = null;
    let requestState = "";
    try {
      const data = JSON.parse(status.stdout).data;
      state = data.task.state;
      waiting = data.waiting || null;
      requestState = data.requestGraph ? data.requestGraph.state : data.request ? data.request.state : "";
    } catch (error) {
      throw new Error("AmpleFile returned an unreadable task status.");
    }
    if (waiting || requestState === "waiting") {
      if (plan.json) {
        emitOutcome(status);
        return 0;
      }
      const humanStatus = performRequest(context, statusArgv.slice(0, -1), actToken, null);
      emitOutcome(humanStatus);
      return humanStatus.exitCode;
    }
    if (requestState ? requestState !== "working" && requestState !== "handed_off" : state !== "accepted" && state !== "running") break;
    if (Date.now() >= deadline) {
      writeHandle($.NSFileHandle.fileHandleWithStandardError, `AmpleFile: ${plan.group} wait timed out after ${plan.timeoutSeconds}s.\n`);
      return 7;
    }
    $.NSThread.sleepForTimeInterval(2);
  }
  const resultArgv = [plan.group, "result"].concat(scopeArgv, ["--task", plan.task]);
  if (plan.json) resultArgv.push("--json");
  const result = performRequest(context, resultArgv, actToken, null);
  emitOutcome(result);
  return result.exitCode;
}

function parseAutomationWaitCommand(argumentsList) {
  const positional = argumentsList.filter((token) => token !== "--json");
  if (positional[0] !== "automations" || positional[1] !== "wait") return null;
  const json = argumentsList.includes("--json");
  let automation = "";
  let run = "";
  let timeoutSeconds = 3600;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (token === "--automation") { automation = argumentsList[index + 1] || ""; index += 1; }
    else if (token === "--run") { run = argumentsList[index + 1] || ""; index += 1; }
    else if (token === "--timeout") {
      timeoutSeconds = Number(argumentsList[index + 1]);
      index += 1;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_WAIT_SECONDS) {
        throw usageFailure(`--timeout must be an integer between 1 and ${MAX_WAIT_SECONDS} seconds.`);
      }
    } else if (token === "automations" || token === "wait" || token === "--json") {
      // command tokens
    } else {
      throw usageFailure(`Unknown option for automations wait: ${token}`);
    }
  }
  if (!automation) throw usageFailure("Provide --automation <id>.");
  if (!run) throw usageFailure("Provide --run <id> from automations run.");
  return { automation, run, timeoutSeconds, json };
}

function runAutomationWaitLoop(context, plan, actToken) {
  // Each poll is one quick status read, so nothing holds the app while the
  // run's own steps use the amplefile command. The loop ends when the run
  // settles and prints that status; a run that did not succeed exits 1.
  const statusArgv = ["automations", "status", "--automation", plan.automation, "--run", plan.run, "--json"];
  const deadline = Date.now() + plan.timeoutSeconds * 1000;
  for (;;) {
    const status = performRequest(context, statusArgv, actToken, null);
    if (status.exitCode !== 0) {
      emitOutcome(status);
      return status.exitCode;
    }
    let run = null;
    try {
      run = JSON.parse(status.stdout).data.run;
    } catch (error) {
      throw new Error("AmpleFile returned an unreadable automation run status.");
    }
    if (run && run.state === "settled") {
      const shown = plan.json ? status : performRequest(context, statusArgv.slice(0, -1), actToken, null);
      emitOutcome(shown);
      if (shown.exitCode !== 0) return shown.exitCode;
      return run.outcome === "success" ? 0 : 1;
    }
    if (Date.now() >= deadline) {
      writeHandle($.NSFileHandle.fileHandleWithStandardError, `AmpleFile: automations wait timed out after ${plan.timeoutSeconds}s.\n`);
      return 7;
    }
    $.NSThread.sleepForTimeInterval(2);
  }
}

/**
 * Rewrites --message-file <path> into a bounded payload the host can trust,
 * and takes the caller's own --request-id as the id to send the request
 * under. That flag stays in argv so the host can check the two agree.
 */
function prepareActArguments(argumentsList) {
  const argv = [];
  let payload = null;
  let requestId = null;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (token === "--request-id" || token.startsWith("--request-id=")) {
      const value = token === "--request-id" ? argumentsList[index + 1] : token.slice("--request-id=".length);
      if (token === "--request-id") index += 1;
      if (requestId) throw usageFailure("--request-id may be provided only once.");
      requestId = normalizedRequestId(value);
      argv.push("--request-id", requestId);
      continue;
    }
    if (token !== "--message-file") {
      argv.push(token);
      continue;
    }
    const path = argumentsList[index + 1];
    index += 1;
    if (!path) throw usageFailure("--message-file requires a path.");
    if (payload) throw usageFailure("--message-file may be provided only once.");
    const text = readText(resolvePath(path));
    const byteLength = ObjC.unwrap($(text).dataUsingEncoding($.NSUTF8StringEncoding).length);
    if (byteLength > ACT_MAX_MESSAGE_FILE_BYTES) {
      throw usageFailure(`--message-file exceeds ${ACT_MAX_MESSAGE_FILE_BYTES} bytes.`);
    }
    payload = { messageFile: text };
    argv.push("--message-from-payload");
  }
  return { argv, payload, requestId };
}

/** The broker's request id form: a UUID, lowercased (uuidgen prints capitals). */
function normalizedRequestId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw usageFailure("--request-id must be a UUID, such as one uuidgen prints.");
  }
  return normalized;
}

function readActToken(cliRoot) {
  const path = `${cliRoot}/act-token.json`;
  if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) return null;
  try {
    const record = JSON.parse(readText(path));
    if (record.version !== 1 || typeof record.actToken !== "string") return null;
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(record.actToken)) return null;
    return record.actToken;
  } catch (error) {
    return null;
  }
}

function performRequest(context, argv, actToken, payload, suppliedRequestId) {
  const fileManager = context.fileManager;
  const requestId = suppliedRequestId || ObjC.unwrap($.NSUUID.UUID.UUIDString).toLowerCase();
  const requestPath = `${context.cliRoot}/requests/${requestId}.json`;
  const responsePath = `${context.cliRoot}/responses/${requestId}.json`;
  let temporaryRequestPath = `${context.cliRoot}/requests/${requestId}.${ObjC.unwrap($.NSUUID.UUID.UUIDString).toLowerCase()}.tmp`;
  let writtenAt = "";

  try {
    // A caller retrying under its own id while the first try still waits to
    // be picked up joins that try: one request, one answer, never two runs.
    if (suppliedRequestId && fileManager.fileExistsAtPath($(requestPath))) {
      temporaryRequestPath = "";
      return awaitResponse(context, requestId, responsePath, actToken);
    }
    const request = actToken
      ? {
          protocolVersion: 3,
          lane: "act",
          id: requestId,
          argv: argv,
          cwd: ObjC.unwrap(fileManager.currentDirectoryPath),
          createdAt: new Date().toISOString(),
          actToken: actToken,
        }
      : {
          protocolVersion: 1,
          id: requestId,
          argv: argv,
          cwd: ObjC.unwrap(fileManager.currentDirectoryPath),
          createdAt: new Date().toISOString(),
        };
    if (actToken && payload) request.payload = payload;
    writtenAt = request.createdAt;
    writeText(temporaryRequestPath, JSON.stringify(request));
    if (!fileManager.moveItemAtPathToPathError($(temporaryRequestPath), $(requestPath), null)) {
      throw new Error("AmpleFile CLI request could not be committed.");
    }
    temporaryRequestPath = "";
    return awaitResponse(context, requestId, responsePath, actToken);
  } finally {
    // An id this shim made up is its own, so it clears everything. Under a
    // caller's own id another caller may be waiting on the same answer, or
    // may come back for it: the shim leaves the answer, which AmpleFile
    // removes after a few minutes, and removes a request file only if it
    // wrote that file itself.
    const ownFiles = suppliedRequestId
      ? [temporaryRequestPath, writtenAt && requestFileCreatedAt(requestPath) === writtenAt ? requestPath : ""]
      : [temporaryRequestPath, requestPath, responsePath];
    for (const path of ownFiles) {
      if (path && fileManager.fileExistsAtPath($(path))) fileManager.removeItemAtPathError($(path), null);
    }
  }
}

/** The creation time a request file records, or "" when it cannot be read. */
function requestFileCreatedAt(path) {
  if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) return "";
  try {
    return String(JSON.parse(readText(path)).createdAt || "");
  } catch (error) {
    return "";
  }
}

/** Hands the committed request id to the app and waits for its answer. */
function awaitResponse(context, requestId, responsePath, actToken) {
  const fileManager = context.fileManager;
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath($(context.appPath));
  task.arguments = $(["--amplefile-cli-request", requestId]);
  if (!task.launchAndReturnError(null)) throw new Error("AmpleFile executable could not be launched.");

  const deadline = Date.now() + context.timeoutMs;
  while (!fileManager.fileExistsAtPath($(responsePath))) {
    if (Date.now() >= deadline) {
      // An act may still run after this wait ends; its receipt says whether it did.
      const followUp = actToken ? ` 'amplefile receipts show --id ${requestId}' tells whether it ran.` : "";
      throw transportTimeout(`AmpleFile did not answer CLI request ${requestId} within ${context.timeoutMs} ms.${followUp}`);
    }
    $.NSThread.sleepForTimeInterval(0.05);
  }

  const response = JSON.parse(readText(responsePath));
  if (response.protocolVersion !== 1) throw new Error(`AmpleFile returned unsupported CLI protocol version ${response.protocolVersion}.`);
  if (response.id !== requestId) throw new Error("AmpleFile returned a CLI response with the wrong request id.");
  if (!Number.isInteger(response.exitCode)) throw new Error("AmpleFile returned an invalid CLI exit code.");
  return {
    exitCode: response.exitCode,
    stdout: typeof response.stdout === "string" ? response.stdout : "",
    stderr: typeof response.stderr === "string" ? response.stderr : "",
  };
}

function emitOutcome(outcome) {
  writeHandle($.NSFileHandle.fileHandleWithStandardOutput, outcome.stdout);
  writeHandle($.NSFileHandle.fileHandleWithStandardError, outcome.stderr);
}

function resolvePath(path) {
  if (path.startsWith("/")) return path;
  const cwd = ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
  return `${cwd}/${path}`;
}

function usageFailure(message) {
  const error = new Error(`${message}\nRun 'amplefile help' for usage.`);
  error.exitCode = 2;
  return error;
}

function transportTimeout(message) {
  const error = new Error(message);
  error.exitCode = 124;
  return error;
}

function environmentValue(name) {
  const value = $.NSProcessInfo.processInfo.environment.objectForKey($(name));
  const unwrapped = ObjC.unwrap(value);
  return typeof unwrapped === "string" ? unwrapped.trim() : "";
}

function createDirectory(path) {
  if (!$.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
    $(path),
    true,
    $.NSDictionary.dictionary,
    null,
  )) {
    throw new Error(`AmpleFile CLI directory could not be created at ${path}.`);
  }
}

function writeText(path, text) {
  const data = $(text).dataUsingEncoding($.NSUTF8StringEncoding);
  if (!data.writeToFileAtomically($(path), true)) throw new Error(`AmpleFile CLI request could not be written at ${path}.`);
}

function readText(path) {
  const value = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
  if (!value) throw new Error(`AmpleFile CLI file could not be read at ${path}.`);
  return ObjC.unwrap(value);
}

function writeHandle(handle, text) {
  if (!text) return;
  handle.writeData($(text).dataUsingEncoding($.NSUTF8StringEncoding));
}
