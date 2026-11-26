use amplefile_linux_hosts::{atomic_json, environment, private_directory, private_json};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, (i32, String)>;
const DEFAULT_WAIT_SECONDS: u64 = 3600;
const MAX_WAIT_SECONDS: u64 = 2592000;

fn error(value: impl std::fmt::Display) -> (i32, String) {
    (1, value.to_string())
}
fn usage(value: impl Into<String>) -> (i32, String) {
    (2, value.into())
}
struct Client {
    root: PathBuf,
    app: PathBuf,
    timeout: Duration,
}
struct Outcome {
    code: i32,
    stdout: String,
    stderr: String,
}
impl Outcome {
    fn emit(&self) {
        let _ = io::stdout().write_all(self.stdout.as_bytes());
        let _ = io::stderr().write_all(self.stderr.as_bytes());
    }
}
fn is_act(argv: &[String]) -> bool {
    if argv
        .iter()
        .any(|arg| ["--help", "-h"].contains(&arg.as_str()))
    {
        return false;
    }
    let tokens: Vec<_> = argv
        .iter()
        .filter(|arg| arg.as_str() != "--json")
        .map(String::as_str)
        .collect();
    match tokens.first().copied().unwrap_or("") {
        "chat" | "chats" | "files" | "agent" | "history" | "search" | "tools" | "automations"
        | "recently-deleted" | "requests" | "jobs" | "worktrees" | "receipts" => true,
        "connected-folders" => tokens.get(1) != Some(&"list"),
        _ => false,
    }
}
impl Client {
    fn request(
        &self,
        argv: &[String],
        token: Option<&str>,
        payload: Option<Value>,
        act_request_id: Option<&str>,
    ) -> Result<Outcome> {
        let id = uuid::Uuid::new_v4().to_string();
        let request_path = self.root.join("requests").join(format!("{id}.json"));
        let response_path = self.root.join("responses").join(format!("{id}.json"));
        let result = (|| {
            let mut request = json!({"protocolVersion": if token.is_some() {3} else {1}, "id":id, "argv":argv,
                "cwd":env::current_dir().map_err(error)?, "createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)});
            if let Some(token) = token {
                request["lane"] = json!("act");
                request["actToken"] = json!(token);
            }
            if let Some(payload) = payload {
                request["payload"] = payload;
            }
            let limit = if token.is_some() {
                128 * 1024 * 1024
            } else {
                64 * 1024 * 1024
            };
            if serde_json::to_vec(&request).map_err(error)?.len() > limit {
                return Err(usage(format!("CLI request exceeds {limit} bytes.")));
            }
            atomic_json(&request_path, &request).map_err(error)?;
            let mut child = Command::new(&self.app)
                .args(["--amplefile-cli-request", &id])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .env_remove("ELECTRON_RUN_AS_NODE")
                .spawn()
                .map_err(error)?;
            // Reap second-instance launchers without waiting for the interactive host.
            thread::spawn(move || {
                let _ = child.wait();
            });
            let deadline = Instant::now() + self.timeout;
            loop {
                match private_json(&response_path, 256 * 1024 * 1024) {
                    Ok(response) => {
                        if response["protocolVersion"] != 1 || response["id"] != id {
                            return Err(error("Invalid CLI response identity or version"));
                        }
                        let code = response["exitCode"]
                            .as_i64()
                            .filter(|n| (0..=255).contains(n))
                            .ok_or_else(|| error("Invalid CLI exit code"))?
                            as i32;
                        return Ok(Outcome {
                            code,
                            stdout: response["stdout"].as_str().unwrap_or("").into(),
                            stderr: response["stderr"].as_str().unwrap_or("").into(),
                        });
                    }
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    Err(err) => return Err(error(err)),
                }
                if Instant::now() >= deadline {
                    let timeout_ms = self.timeout.as_millis();
                    let message = if token.is_some() {
                        let act_id = act_request_id.unwrap_or(&id);
                        format!("AmpleFile did not answer act {act_id} within {timeout_ms} ms. 'amplefile receipts show --id {act_id}' tells whether it ran.")
                    } else {
                        format!("AmpleFile did not answer CLI request {id} within {timeout_ms} ms.")
                    };
                    return Err((124, message));
                }
                thread::sleep(Duration::from_millis(50));
            }
        })();
        let _ = fs::remove_file(request_path);
        let _ = fs::remove_file(response_path);
        result
    }
}
#[derive(Debug)]
struct PreparedAct {
    argv: Vec<String>,
    payload: Option<Value>,
    request_id: Option<String>,
}

fn normalize_request_id(value: &str) -> Result<String> {
    let id = value.trim().to_ascii_lowercase();
    if uuid::Uuid::parse_str(&id).is_ok_and(|uuid| uuid.to_string() == id)
        && matches!(id.as_bytes()[14], b'1'..=b'8')
        && matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
    {
        return Ok(id);
    }
    Err(usage(
        "--request-id must be a UUID, such as one uuidgen prints.",
    ))
}

fn prepare(argv: Vec<String>) -> Result<PreparedAct> {
    let mut out = Vec::new();
    let mut payload = None;
    let mut request_id = None;
    let mut args = argv.into_iter();
    while let Some(arg) = args.next() {
        let id_value = if arg == "--request-id" {
            Some(args.next().unwrap_or_default())
        } else {
            arg.strip_prefix("--request-id=").map(str::to_owned)
        };
        if let Some(value) = id_value {
            if request_id.is_some() {
                return Err(usage("--request-id may be provided only once."));
            }
            let id = normalize_request_id(&value)?;
            out.extend(["--request-id".into(), id.clone()]);
            request_id = Some(id);
            continue;
        }
        if arg != "--message-file" {
            out.push(arg);
            continue;
        }
        if payload.is_some() {
            return Err(usage("--message-file may be provided only once."));
        }
        let path = args
            .next()
            .ok_or_else(|| usage("--message-file requires a path."))?;
        let file = fs::File::open(path).map_err(error)?;
        if !file.metadata().map_err(error)?.is_file() {
            return Err(usage("--message-file must name a regular file."));
        }
        let mut bytes = Vec::new();
        file.take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(usage("--message-file exceeds 16777216 bytes."));
        }
        let text = String::from_utf8(bytes).map_err(|_| usage("--message-file must be UTF-8."))?;
        payload = Some(json!({"messageFile":text}));
        out.push("--message-from-payload".into());
    }
    Ok(PreparedAct {
        argv: out,
        payload,
        request_id,
    })
}
fn wait(client: &Client, argv: &[String], token: &str) -> Result<Option<Outcome>> {
    let tokens: Vec<_> = argv.iter().filter(|a| a.as_str() != "--json").collect();
    let group = tokens.first().map(|s| s.as_str()).unwrap_or("");
    if !["chat", "agent"].contains(&group) || tokens.get(1).map(|s| s.as_str()) != Some("wait") {
        return Ok(None);
    }
    let mut space = None;
    let mut task = None;
    let mut seconds = DEFAULT_WAIT_SECONDS;
    let mut index = 2;
    while index < tokens.len() {
        let option = tokens[index].as_str();
        let value = tokens
            .get(index + 1)
            .ok_or_else(|| usage(format!("{option} requires a value.")))?;
        match option {
            "--connected-folder" if space.is_none() => space = Some((*value).clone()),
            "--task" if task.is_none() => task = Some((*value).clone()),
            "--timeout" => {
                seconds = value
                    .parse::<u64>()
                    .ok()
                    .filter(|s| (1..=MAX_WAIT_SECONDS).contains(s))
                    .ok_or_else(|| {
                        usage(format!(
                            "--timeout must be between 1 and {MAX_WAIT_SECONDS} seconds."
                        ))
                    })?
            }
            _ => {
                return Err(usage(format!(
                    "Unknown or repeated option for {group} wait: {option}"
                )))
            }
        }
        index += 2;
    }
    if group == "agent" && space.is_some() {
        return Err(usage(
            "The AmpleFile Agent scope does not take --connected-folder.",
        ));
    }
    if group != "agent" && space.is_none() {
        return Err(usage(
            "Act commands require an explicit --connected-folder <id-or-name>.",
        ));
    }
    let task = task.ok_or_else(|| usage("Provide --task <id>."))?;
    let mut scope = Vec::new();
    if let Some(space) = space {
        scope.extend(["--connected-folder".into(), space]);
    }
    scope.extend(["--task".into(), task]);
    let json_output = argv.iter().any(|s| s == "--json");
    let mut status = vec![
        group.into(),
        if group == "checks" {
            "task".into()
        } else {
            "status".into()
        },
    ];
    status.extend(scope.clone());
    status.push("--json".into());
    let deadline = Instant::now() + Duration::from_secs(seconds);
    loop {
        let result = client.request(&status, Some(token), None, None)?;
        if result.code != 0 {
            return Ok(Some(result));
        }
        let value: Value = serde_json::from_str(&result.stdout).map_err(error)?;
        let data = &value["data"];
        let state = data["task"]["state"]
            .as_str()
            .ok_or_else(|| error("Unreadable task status"))?;
        let request_state = data["requestGraph"]["state"]
            .as_str()
            .or(data["request"]["state"].as_str());
        if !data["waiting"].is_null() || request_state == Some("waiting") {
            if json_output {
                return Ok(Some(result));
            }
            status.pop();
            return client.request(&status, Some(token), None, None).map(Some);
        }
        let running = request_state
            .map(|s| ["working", "handed_off"].contains(&s))
            .unwrap_or(["accepted", "running"].contains(&state));
        if !running {
            break;
        }
        if Instant::now() >= deadline {
            return Err((7, format!("{group} wait timed out after {seconds}s.")));
        }
        thread::sleep(Duration::from_secs(2));
    }
    let mut result = vec![group.into(), "result".into()];
    result.extend(scope);
    if json_output {
        result.push("--json".into());
    }
    client.request(&result, Some(token), None, None).map(Some)
}

#[derive(Debug, PartialEq, Eq)]
struct AutomationWait {
    automation: String,
    run: String,
    timeout_seconds: u64,
    json: bool,
}

fn parse_automation_wait(argv: &[String]) -> Result<Option<AutomationWait>> {
    let mut positional = argv
        .iter()
        .map(String::as_str)
        .filter(|arg| *arg != "--json");
    if positional.next() != Some("automations") || positional.next() != Some("wait") {
        return Ok(None);
    }

    let mut automation = "";
    let mut run = "";
    let mut timeout_seconds = DEFAULT_WAIT_SECONDS;
    let mut args = argv.iter().map(String::as_str);
    while let Some(arg) = args.next() {
        match arg {
            "automations" | "wait" | "--json" => {}
            "--automation" => automation = args.next().unwrap_or_default(),
            "--run" => run = args.next().unwrap_or_default(),
            "--timeout" => {
                timeout_seconds = args.next()
                    .and_then(|s| s.trim().parse::<f64>().ok())
                    .filter(|s| s.fract() == 0.0 && (1.0..=MAX_WAIT_SECONDS as f64).contains(s))
                    .map(|s| s as u64)
                    .ok_or_else(|| usage(format!("--timeout must be an integer between 1 and {MAX_WAIT_SECONDS} seconds.")))?;
            }
            _ => return Err(usage(format!("Unknown option for automations wait: {arg}"))),
        }
    }
    if automation.is_empty() {
        return Err(usage("Provide --automation <id>."));
    }
    if run.is_empty() {
        return Err(usage("Provide --run <id> from automations run."));
    }
    Ok(Some(AutomationWait {
        automation: automation.into(),
        run: run.into(),
        timeout_seconds,
        json: argv.iter().any(|arg| arg == "--json"),
    }))
}

fn wait_for_automation(client: &Client, plan: AutomationWait, token: &str) -> Result<Outcome> {
    let mut argv = vec![
        "automations".into(),
        "status".into(),
        "--automation".into(),
        plan.automation,
        "--run".into(),
        plan.run,
        "--json".into(),
    ];
    let deadline = Instant::now() + Duration::from_secs(plan.timeout_seconds);
    loop {
        // Short status requests leave the host available for CLI calls within the run.
        let status = client.request(&argv, Some(token), None, None)?;
        if status.code != 0 {
            return Ok(status);
        }
        let unreadable = || error("AmpleFile returned an unreadable automation run status.");
        let value: Value = serde_json::from_str(&status.stdout).map_err(|_| unreadable())?;
        let data = value
            .get("data")
            .filter(|data| !data.is_null())
            .ok_or_else(unreadable)?;
        let run = &data["run"];
        if run["state"] == "settled" {
            let mut shown = if plan.json {
                status
            } else {
                argv.pop();
                client.request(&argv, Some(token), None, None)?
            };
            if shown.code == 0 && run["outcome"] != "success" {
                shown.code = 1;
            }
            return Ok(shown);
        }
        if Instant::now() >= deadline {
            return Err((
                7,
                format!(
                    "automations wait timed out after {}s.",
                    plan.timeout_seconds
                ),
            ));
        }
        thread::sleep(Duration::from_secs(2));
    }
}

fn run() -> Result<Outcome> {
    let argv: Vec<_> = env::args().skip(1).collect();
    let executable = env::current_exe().map_err(error)?;
    let app = environment("AMPLEFILE_CLI_APP")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            executable
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("amplefile-desktop")
        });
    let base = environment("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| environment("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or_else(|| error("HOME or XDG_CONFIG_HOME is required"))?;
    let root = environment("AMPLEFILE_CLI_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| base.join("AmpleFile"))
        .join("cli");
    let timeout = environment("AMPLEFILE_CLI_TIMEOUT_MS")
        .unwrap_or_else(|| "1800000".into())
        .parse::<u64>()
        .ok()
        .filter(|n| *n >= 100)
        .ok_or_else(|| usage("AMPLEFILE_CLI_TIMEOUT_MS must be an integer of at least 100."))?;
    private_directory(&root).map_err(error)?;
    private_directory(&root.join("requests")).map_err(error)?;
    private_directory(&root.join("responses")).map_err(error)?;
    let client = Client {
        root,
        app,
        timeout: Duration::from_millis(timeout),
    };
    if is_act(&argv) {
        let token = private_json(&client.root.join("act-token.json"), 4096).ok()
            .filter(|record| record["version"] == 1).and_then(|record| record["actToken"].as_str().map(str::to_owned))
            .filter(|s| (16..=256).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
            .ok_or_else(|| (6, "Open AmpleFile to run this command. Act commands need the AmpleFile app running.".into()))?;
        if let Some(result) = wait(&client, &argv, &token)? {
            return Ok(result);
        }
        if let Some(plan) = parse_automation_wait(&argv)? {
            return wait_for_automation(&client, plan, &token);
        }
        let prepared = prepare(argv)?;
        client.request(
            &prepared.argv,
            Some(&token),
            prepared.payload,
            prepared.request_id.as_deref(),
        )
    } else {
        client.request(&argv, None, None, None)
    }
}
/// The JSON code for a failure the command itself reports, by its exit code.
fn failure_code(exit: i32) -> &'static str {
    match exit {
        2 => "usage",
        6 => "unavailable",
        7 | 124 => "timeout",
        _ => "failure",
    }
}

/// What the command writes to stderr for its own failure: with --json, one
/// JSON object the way the app's answers are shaped; otherwise one line.
fn failure_text(exit: i32, message: &str, json_output: bool) -> String {
    if !json_output {
        return format!("AmpleFile: {message}\n");
    }
    // The Mac command's JSON.stringify(value, null, 2), byte for byte: ok first.
    let quote = |text: &str| serde_json::to_string(text).unwrap_or_default();
    format!(
        "{{\n  \"ok\": false,\n  \"error\": {{\n    \"code\": {},\n    \"message\": {}\n  }}\n}}\n",
        quote(failure_code(exit)),
        quote(message)
    )
}

fn main() {
    // Read before anything can fail, so every failure honors --json.
    let json_output = env::args().skip(1).any(|arg| arg == "--json");
    match run() {
        Ok(outcome) => {
            outcome.emit();
            std::process::exit(outcome.code);
        }
        Err((code, message)) => {
            let _ = io::stderr().write_all(failure_text(code, &message, json_output).as_bytes());
            std::process::exit(code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(argv: &[&str]) -> Vec<String> {
        argv.iter().map(|arg| (*arg).into()).collect()
    }

    #[test]
    fn failures_are_json_with_json_and_one_line_without() {
        for (exit, code) in [(1, "failure"), (2, "usage"), (6, "unavailable"), (7, "timeout"), (124, "timeout")] {
            let text = failure_text(exit, "Something \"quoted\" went wrong.", true);
            assert!(text.ends_with('\n'));
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value, json!({"ok": false, "error": {"code": code, "message": "Something \"quoted\" went wrong."}}));
        }
        assert_eq!(
            failure_text(7, "automations wait timed out after 1s.", true),
            "{\n  \"ok\": false,\n  \"error\": {\n    \"code\": \"timeout\",\n    \"message\": \"automations wait timed out after 1s.\"\n  }\n}\n",
        );
        assert_eq!(failure_text(2, "Provide --task <id>.", false), "AmpleFile: Provide --task <id>.\n");
    }

    #[test]
    fn act_lane_includes_receipts_and_excludes_content_free_reads() {
        for argv in [
            &["receipts", "show"][..],
            &["--json", "automations", "wait"],
            &["connected-folders", "create"],
            &["files", "ls"],
        ] {
            assert!(is_act(&args(argv)), "{argv:?}");
        }
        for argv in [
            &["--json", "context"][..],
            &["connected-folders", "list"],
            &["receipts", "--help"],
            &["automations", "-h"],
        ] {
            assert!(!is_act(&args(argv)), "{argv:?}");
        }
    }

    #[test]
    fn request_id_is_normalized_in_both_flag_forms() {
        let supplied = " 758E9B0C-A155-8E3A-A3CC-577933C30F9F ";
        let id = "758e9b0c-a155-8e3a-a3cc-577933c30f9f";
        for flag in [
            vec!["--request-id", supplied],
            vec![&format!("--request-id={supplied}")],
        ] {
            let prepared = prepare(args(
                &[vec!["agent", "status"], flag, vec!["--json"]].concat(),
            ))
            .unwrap();
            assert_eq!(prepared.request_id.as_deref(), Some(id));
            assert_eq!(
                prepared.argv,
                args(&["agent", "status", "--request-id", id, "--json"])
            );
        }
    }

    #[test]
    fn request_id_rejects_malformed_and_repeated_flags() {
        for invalid in [
            "",
            "req-1",
            "758e9b0ca1554e3aa3cc577933c30f9f",
            "758e9b0c-a155-0e3a-a3cc-577933c30f9f",
            "758e9b0c-a155-9e3a-a3cc-577933c30f9f",
            "758e9b0c-a155-4e3a-c3cc-577933c30f9f",
        ] {
            assert_eq!(
                prepare(args(&["agent", "status", "--request-id", invalid])).unwrap_err(),
                usage("--request-id must be a UUID, such as one uuidgen prints."),
            );
        }
        let id = "758e9b0c-a155-4e3a-a3cc-577933c30f9f";
        assert_eq!(
            prepare(args(&[
                "agent",
                "status",
                "--request-id",
                id,
                &format!("--request-id={id}")
            ]))
            .unwrap_err(),
            usage("--request-id may be provided only once."),
        );
    }

    #[test]
    fn automation_wait_accepts_ids_json_and_bounded_timeout() {
        let argv = [
            "automations",
            "wait",
            "--automation",
            "tidy",
            "--run",
            "run-1",
        ];
        let plan = parse_automation_wait(&args(&argv)).unwrap().unwrap();
        assert_eq!(
            plan,
            AutomationWait {
                automation: "tidy".into(),
                run: "run-1".into(),
                timeout_seconds: 3600,
                json: false,
            }
        );
        let plan = parse_automation_wait(&args(
            &[&argv[..], &["--json", "--timeout", "2592000"]].concat(),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(plan.timeout_seconds, 2592000);
        assert!(plan.json);
        assert_eq!(
            parse_automation_wait(&args(&["automations", "status"])),
            Ok(None)
        );
    }

    #[test]
    fn automation_wait_reports_usage_errors_for_missing_ids_and_unknown_options() {
        for (argv, message) in [
            (&[][..], "Provide --automation <id>."),
            (
                &["--automation", "tidy"],
                "Provide --run <id> from automations run.",
            ),
            (&["--bogus"], "Unknown option for automations wait: --bogus"),
            (
                &["--timeout"],
                "--timeout must be an integer between 1 and 2592000 seconds.",
            ),
            (
                &["--timeout", "0"],
                "--timeout must be an integer between 1 and 2592000 seconds.",
            ),
            (
                &["--timeout", "1.5"],
                "--timeout must be an integer between 1 and 2592000 seconds.",
            ),
            (
                &["--timeout", "2592001"],
                "--timeout must be an integer between 1 and 2592000 seconds.",
            ),
        ] {
            assert_eq!(
                parse_automation_wait(&args(&[&["automations", "wait"][..], argv].concat())),
                Err(usage(message)),
            );
        }
    }
}
