use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

const HTTP_SERVER_ADDRESS: &str = "127.0.0.1:37123";
const MAX_REQUEST_BODY_SIZE: usize = 1024 * 1024;
const MAX_QUEUED_INPUTS: usize = 1000;
const MAX_TOOL_ITERATIONS: usize = 8;
const MAX_TOOL_FILE_SIZE: u64 = 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 200;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HttpInput {
    pub agent: String,
    #[serde(default, alias = "params", alias = "input")]
    pub parameters: Value,
}

#[derive(Clone, Default)]
struct HttpInputQueue(Arc<Mutex<VecDeque<HttpInput>>>);

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    #[serde(default = "bool_true")]
    pub enabled: bool,
    pub transport: String, // "stdio" | "http"
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub url: String,
}

fn bool_true() -> bool { true }

#[derive(Debug, Serialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentExecutionRequest {
    item_id: u32,
    api_base_url: String,
    api_key: String,
    model_name: String,
    prompt: String,
    parameters: Option<Value>,
    #[serde(default)]
    working_directory: String,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    mcp_servers: Vec<McpServerConfig>,
    #[serde(default)]
    selected_mcp_tools: Vec<String>,
    #[serde(default)]
    memory: bool,
    #[serde(default)]
    item_code: String,
}

#[derive(Debug, Serialize)]
struct ToolExecutionLog {
    name: String,
    arguments: Value,
    result: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentExecutionResult {
    endpoint: String,
    content: String,
    stats: Option<Value>,
    tool_calls: Vec<ToolExecutionLog>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelExchangeEvent {
    item_id: u32,
    round: usize,
    phase: String,
    endpoint: String,
    payload: Value,
}

fn emit_model_exchange(
    app_handle: &tauri::AppHandle,
    request: &AgentExecutionRequest,
    round: usize,
    phase: &str,
    endpoint: &str,
    payload: Value,
) {
    let _ = app_handle.emit(
        "model-exchange",
        ModelExchangeEvent {
            item_id: request.item_id,
            round,
            phase: phase.to_string(),
            endpoint: endpoint.to_string(),
            payload,
        },
    );
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ListItem {
    pub id: u32,
    pub name: String,
    pub prompt: String,
    #[serde(rename = "apiBaseUrl")]
    pub api_base_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "modelName")]
    pub model_name: String,
    #[serde(default)]
    #[serde(rename = "workingDirectory")]
    pub working_directory: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    #[serde(rename = "mcpServers")]
    pub mcp_servers: Vec<McpServerConfig>,
    #[serde(default)]
    pub memory: bool,
    #[serde(default)]
    #[serde(rename = "allowHttp")]
    pub allow_http: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Preset {
    pub name: String,
    #[serde(rename = "apiBaseUrl")]
    pub api_base_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "modelName")]
    pub model_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduledEvent {
    pub id: String,
    #[serde(rename = "triggerAt")]
    pub trigger_at: u64,
    #[serde(rename = "agentId")]
    pub agent_id: u32,
    #[serde(default)]
    pub recurrence: String,
    #[serde(default)]
    #[serde(rename = "intervalSeconds")]
    pub interval_seconds: Option<u64>,
    #[serde(default)]
    #[serde(rename = "executedAt")]
    pub executed_at: Option<u64>,
    #[serde(default)]
    #[serde(rename = "executionCount")]
    pub execution_count: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EventMapping {
    pub id: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: u32,
}

fn default_enable_http_input() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub items: Vec<ListItem>,
    #[serde(default)]
    #[serde(rename = "userPresets")]
    pub user_presets: Vec<Preset>,
    #[serde(default)]
    #[serde(rename = "builtinPresets")]
    pub builtin_presets: Vec<Preset>,
    #[serde(default)]
    pub events: Vec<ScheduledEvent>,
    #[serde(default = "default_enable_http_input")]
    #[serde(rename = "enableHttpInput")]
    pub enable_http_input: bool,
    #[serde(default)]
    #[serde(rename = "eventMappings")]
    pub event_mappings: Vec<EventMapping>,
}

fn settings_path() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".listagent").join("settings.json")
}

fn skills_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".listagent").join("skills")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub id: String,
    pub name: String,
    pub description: String,
}

fn parse_skill_meta(id: &str, content: &str) -> SkillMeta {
    let mut name = id.replace('-', " ").replace('_', " ");
    let mut description = String::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") && name == id.replace('-', " ").replace('_', " ") {
            name = trimmed[2..].trim().to_string();
        } else if !trimmed.is_empty() && description.is_empty() && !trimmed.starts_with('#') {
            description = if trimmed.len() > 100 {
                format!("{}…", &trimmed[..99])
            } else {
                trimmed.to_string()
            };
        }
        if !name.is_empty() && !description.is_empty() {
            break;
        }
    }
    SkillMeta { id: id.to_string(), name, description }
}

#[tauri::command]
fn list_skills() -> Result<Vec<SkillMeta>, String> {
    let dir = skills_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut skills: Vec<SkillMeta> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension()?.to_str()? != "md" {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            let content = fs::read_to_string(&path).unwrap_or_default();
            Some(parse_skill_meta(&id, &content))
        })
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

fn load_skill_prompts(skills: &[String]) -> Vec<(String, String)> {
    let dir = skills_dir();
    skills
        .iter()
        .filter_map(|id| {
            let path = dir.join(format!("{id}.md"));
            let content = fs::read_to_string(&path).ok()?;
            let meta = parse_skill_meta(id, &content);
            Some((meta.name, content))
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileMeta {
    pub filename: String,
    pub path: String,
    pub modified_at: u64,
}

fn session_base_dir(working_directory: &str, subdir: &str) -> PathBuf {
    let wd = working_directory.trim();
    let base = if wd.is_empty() {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".listagent").join("sessions")
    } else {
        PathBuf::from(wd).join(".ListAgent")
    };
    base.join(subdir)
}

#[tauri::command]
fn save_session(
    working_directory: String,
    subdir: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    let dir = session_base_dir(&working_directory, &subdir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_sessions(
    working_directory: String,
    subdir: String,
) -> Result<Vec<SessionFileMeta>, String> {
    let dir = session_base_dir(&working_directory, &subdir);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        if !filename.starts_with("session_") {
            continue;
        }
        let modified_at = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        sessions.push(SessionFileMeta {
            filename,
            path: path.to_string_lossy().to_string(),
            modified_at,
        });
    }
    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(sessions)
}

#[tauri::command]
fn read_session_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_settings() -> Result<Settings, String> {
    let path = settings_path();
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let settings: Settings = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        Ok(settings)
    } else {
        Ok(Settings {
            items: vec![],
            user_presets: vec![],
            builtin_presets: vec![],
            events: vec![],
            enable_http_input: true,
            event_mappings: vec![],
        })
    }
}

#[tauri::command]
fn write_settings(settings: Settings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn take_http_inputs(queue: State<'_, HttpInputQueue>) -> Vec<HttpInput> {
    queue
        .0
        .lock()
        .map(|mut pending| pending.drain(..).collect())
        .unwrap_or_default()
}

fn tool_definitions(selected: &[String]) -> Result<Vec<Value>, String> {
    selected
        .iter()
        .map(|name| match name.as_str() {
            "list_directory" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "list_directory",
                    "description": "List files and directories inside a workspace directory.",
                    "parameters": {
                        "type": "object",
                        "properties": { "path": { "type": "string", "description": "Workspace-relative path. Defaults to ." } },
                        "additionalProperties": false
                    }
                }
            })),
            "search_content" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "search_content",
                    "description": "Recursively search UTF-8 file contents in the workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Workspace-relative file or directory path. Defaults to ." },
                            "query": { "type": "string" },
                            "case_sensitive": { "type": "boolean", "default": false }
                        },
                        "required": ["query"],
                        "additionalProperties": false
                    }
                }
            })),
            "read_file" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a UTF-8 text file from the workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": { "path": { "type": "string" } },
                        "required": ["path"],
                        "additionalProperties": false
                    }
                }
            })),
            "write_file" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Create or overwrite a UTF-8 text file in an existing workspace directory.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "content": { "type": "string" }
                        },
                        "required": ["path", "content"],
                        "additionalProperties": false
                    }
                }
            })),
            "replace_string" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "replace_string",
                    "description": "Replace an exact string in a UTF-8 workspace file.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "old_string": { "type": "string" },
                            "new_string": { "type": "string" },
                            "replace_all": { "type": "boolean", "default": false }
                        },
                        "required": ["path", "old_string", "new_string"],
                        "additionalProperties": false
                    }
                }
            })),
            "trigger_event" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "trigger_event",
                    "description": "Trigger a custom event that can execute other agents configured to listen to this event ID.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "event_id": { "type": "string", "description": "The unique identifier of the event." },
                            "message": { "type": "string", "description": "The message payload of the event." },
                            "arg1": { "type": "string", "description": "Argument 1 of the event." },
                            "arg2": { "type": "string", "description": "Argument 2 of the event." },
                            "arg3": { "type": "string", "description": "Argument 3 of the event." }
                        },
                        "required": ["event_id"],
                        "additionalProperties": false
                    }
                }
            })),
            _ => Err(format!("不支援的工具：{name}")),
        })
        .collect()
}

fn tool_workspace_root(configured_directory: &str) -> Result<PathBuf, String> {
    let current_directory =
        std::env::current_dir().map_err(|error| format!("無法取得 App 工作目錄：{error}"))?;
    let configured_directory = configured_directory.trim();
    let root = if configured_directory.is_empty() {
        current_directory
    } else {
        let configured_path = Path::new(configured_directory);
        if configured_path.is_absolute() {
            configured_path.to_path_buf()
        } else {
            current_directory.join(configured_path)
        }
    };
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("工作目錄不存在或無法存取：{error}"))?;
    if !canonical.is_dir() {
        return Err("設定的工作目錄不是資料夾".to_string());
    }
    Ok(canonical)
}

fn ensure_inside_workspace(root: &Path, path: PathBuf) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("路徑不存在或無法存取：{error}"))?;
    if !canonical.starts_with(root) {
        return Err("拒絕存取工具工作目錄以外的路徑".to_string());
    }
    Ok(canonical)
}

fn resolve_existing_tool_path(root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw_path);
    ensure_inside_workspace(
        root,
        if path.is_absolute() {
            path.into()
        } else {
            root.join(path)
        },
    )
}

fn resolve_write_tool_path(root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw_path);
    let candidate = if path.is_absolute() {
        path.into()
    } else {
        root.join(path)
    };
    if candidate.exists() {
        return ensure_inside_workspace(root, candidate);
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| "write_file 路徑缺少父目錄".to_string())?;
    ensure_inside_workspace(root, parent.to_path_buf())?;
    Ok(candidate)
}

fn required_string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少字串參數 {name}"))
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn search_file_content(
    root: &Path,
    path: &Path,
    query: &str,
    case_sensitive: bool,
    matches: &mut Vec<Value>,
) {
    if matches.len() >= MAX_SEARCH_RESULTS {
        return;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.is_dir() {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(canonical) = entry.path().canonicalize() else {
                continue;
            };
            if canonical.starts_with(root) {
                search_file_content(root, &canonical, query, case_sensitive, matches);
            }
            if matches.len() >= MAX_SEARCH_RESULTS {
                break;
            }
        }
        return;
    }
    if !metadata.is_file() || metadata.len() > MAX_TOOL_FILE_SIZE {
        return;
    }
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let normalized_query = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    for (index, line) in content.lines().enumerate() {
        let haystack = if case_sensitive {
            line.to_string()
        } else {
            line.to_lowercase()
        };
        if haystack.contains(&normalized_query) {
            matches.push(serde_json::json!({
                "path": relative_display(root, path),
                "line": index + 1,
                "text": line
            }));
            if matches.len() >= MAX_SEARCH_RESULTS {
                break;
            }
        }
    }
}

fn execute_tool(
    app_handle: Option<&tauri::AppHandle>,
    root: &Path,
    name: &str,
    arguments: &Value,
) -> Result<String, String> {
    match name {
        "list_directory" => {
            let path = resolve_existing_tool_path(
                root,
                arguments.get("path").and_then(Value::as_str).unwrap_or("."),
            )?;
            if !path.is_dir() {
                return Err("list_directory 的 path 不是目錄".to_string());
            }
            let mut entries = Vec::new();
            for entry in fs::read_dir(&path)
                .map_err(|error| error.to_string())?
                .take(1000)
            {
                let entry = entry.map_err(|error| error.to_string())?;
                let canonical = match entry.path().canonicalize() {
                    Ok(path) if path.starts_with(root) => path,
                    _ => continue,
                };
                let metadata = entry.metadata().map_err(|error| error.to_string())?;
                entries.push(serde_json::json!({
                    "name": entry.file_name().to_string_lossy(),
                    "path": relative_display(root, &canonical),
                    "type": if metadata.is_dir() { "directory" } else { "file" },
                    "size": metadata.len()
                }));
            }
            serde_json::to_string(&entries).map_err(|error| error.to_string())
        }
        "search_content" => {
            let query = required_string(arguments, "query")?;
            if query.is_empty() {
                return Err("search_content 的 query 不可為空".to_string());
            }
            let path = resolve_existing_tool_path(
                root,
                arguments.get("path").and_then(Value::as_str).unwrap_or("."),
            )?;
            let mut matches = Vec::new();
            search_file_content(
                root,
                &path,
                query,
                arguments
                    .get("case_sensitive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                &mut matches,
            );
            serde_json::to_string(&matches).map_err(|error| error.to_string())
        }
        "read_file" => {
            let path = resolve_existing_tool_path(root, required_string(arguments, "path")?)?;
            let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
            if !metadata.is_file() || metadata.len() > MAX_TOOL_FILE_SIZE {
                return Err("read_file 僅支援 1 MB 以下的文字檔".to_string());
            }
            fs::read_to_string(path).map_err(|error| format!("無法讀取 UTF-8 文字檔：{error}"))
        }
        "write_file" => {
            let path = resolve_write_tool_path(root, required_string(arguments, "path")?)?;
            let content = required_string(arguments, "content")?;
            if content.len() as u64 > MAX_TOOL_FILE_SIZE {
                return Err("write_file 內容不可超過 1 MB".to_string());
            }
            fs::write(&path, content).map_err(|error| error.to_string())?;
            Ok(format!(
                "已寫入 {} bytes 至 {}",
                content.len(),
                relative_display(root, &path)
            ))
        }
        "replace_string" => {
            let path = resolve_existing_tool_path(root, required_string(arguments, "path")?)?;
            let old_string = required_string(arguments, "old_string")?;
            let new_string = required_string(arguments, "new_string")?;
            if old_string.is_empty() {
                return Err("replace_string 的 old_string 不可為空".to_string());
            }
            let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            if content.len() as u64 > MAX_TOOL_FILE_SIZE {
                return Err("replace_string 僅支援 1 MB 以下的文字檔".to_string());
            }
            let count = content.matches(old_string).count();
            if count == 0 {
                return Err("找不到 old_string".to_string());
            }
            let replace_all = arguments
                .get("replace_all")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let replaced = if replace_all {
                content.replace(old_string, new_string)
            } else {
                content.replacen(old_string, new_string, 1)
            };
            if replaced.len() as u64 > MAX_TOOL_FILE_SIZE {
                return Err("replace_string 的結果不可超過 1 MB".to_string());
            }
            fs::write(&path, replaced).map_err(|error| error.to_string())?;
            Ok(format!("已替換 {} 處", if replace_all { count } else { 1 }))
        }
        "trigger_event" => {
            let event_id = required_string(arguments, "event_id")?;
            let message = arguments.get("message").and_then(Value::as_str).unwrap_or("");
            let arg1 = arguments.get("arg1").and_then(Value::as_str).unwrap_or("");
            let arg2 = arguments.get("arg2").and_then(Value::as_str).unwrap_or("");
            let arg3 = arguments.get("arg3").and_then(Value::as_str).unwrap_or("");
            if event_id.is_empty() {
                return Err("trigger_event 的 event_id 不可為空".to_string());
            }
            if let Some(handle) = app_handle {
                #[derive(Debug, Clone, serde::Serialize)]
                struct AgentEventPayload {
                    #[serde(rename = "eventId")]
                    event_id: String,
                    message: String,
                    arg1: String,
                    arg2: String,
                    arg3: String,
                }
                let _ = handle.emit("agent-event-triggered", AgentEventPayload {
                    event_id: event_id.to_string(),
                    message: message.to_string(),
                    arg1: arg1.to_string(),
                    arg2: arg2.to_string(),
                    arg3: arg3.to_string(),
                });
            }
            Ok(format!("已觸發事件：事件 ID 為「{}」，訊息為「{}」，arg1為「{}」，arg2為「{}」，arg3為「{}」", event_id, message, arg1, arg2, arg3))
        }
        _ => Err(format!("工具未啟用或不存在：{name}")),
    }
}

// ============================================================
// MCP client
// ============================================================

enum McpClientState {
    Stdio {
        stdin: tokio::process::ChildStdin,
        reader: tokio::io::BufReader<tokio::process::ChildStdout>,
        _child: tokio::process::Child,
        request_id: u64,
    },
    Http {
        client: reqwest::Client,
        url: String,
        request_id: u64,
    },
}

impl McpClientState {
    async fn send_json_rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        match self {
            McpClientState::Stdio { stdin, reader, request_id, .. } => {
                *request_id += 1;
                let id = *request_id;
                let req = serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
                let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
                line.push('\n');
                stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())?;
                loop {
                    let mut resp = String::new();
                    reader.read_line(&mut resp).await.map_err(|e| e.to_string())?;
                    if resp.is_empty() { return Err("MCP server 已關閉".to_string()); }
                    let v: Value = serde_json::from_str(resp.trim()).map_err(|e| e.to_string())?;
                    if v.get("id").map(|x| !x.is_null()).unwrap_or(false) {
                        if let Some(err) = v.get("error") {
                            return Err(format!("MCP 錯誤：{err}"));
                        }
                        return Ok(v["result"].clone());
                    }
                }
            }
            McpClientState::Http { client, url, request_id } => {
                *request_id += 1;
                let id = *request_id;
                let req = serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
                let v: Value = client.post(url.as_str()).json(&req).send().await
                    .map_err(|e| e.to_string())?
                    .json().await.map_err(|e| e.to_string())?;
                if let Some(err) = v.get("error") {
                    return Err(format!("MCP 錯誤：{err}"));
                }
                Ok(v["result"].clone())
            }
        }
    }

    async fn list_tools(&mut self) -> Result<Vec<Value>, String> {
        let result = self.send_json_rpc("tools/list", serde_json::json!({})).await?;
        Ok(result.get("tools").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    async fn call_tool(&mut self, name: &str, args: &Value) -> Result<String, String> {
        let result = self.send_json_rpc(
            "tools/call",
            serde_json::json!({"name": name, "arguments": args}),
        ).await?;
        if let Some(content) = result.get("content").and_then(Value::as_array) {
            let text = content.iter()
                .filter_map(|item| {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        item.get("text").and_then(Value::as_str).map(str::to_string)
                    } else {
                        serde_json::to_string(item).ok()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            Ok(text)
        } else {
            Ok(serde_json::to_string(&result).unwrap_or_default())
        }
    }
}

async fn init_mcp_client(config: &McpServerConfig, working_dir: &str) -> Result<McpClientState, String> {
    let mut client = match config.transport.as_str() {
        "stdio" => {
            if config.command.trim().is_empty() {
                return Err("未設定 command".to_string());
            }
            // On Windows, tokio::process::Command cannot resolve .cmd/.bat scripts
            // (npm-installed globals, etc.) without going through cmd.exe.
            #[cfg(target_os = "windows")]
            let mut cmd = {
                let mut c = tokio::process::Command::new("cmd");
                c.arg("/C").arg(&config.command).args(&config.args);
                c
            };
            #[cfg(not(target_os = "windows"))]
            let mut cmd = {
                let mut c = tokio::process::Command::new(&config.command);
                c.args(&config.args);
                c
            };
            cmd.envs(&config.env)
               .stdin(std::process::Stdio::piped())
               .stdout(std::process::Stdio::piped())
               .stderr(std::process::Stdio::null())
               .kill_on_drop(true);
            if !working_dir.is_empty() {
                cmd.current_dir(working_dir);
            }
            let mut child = cmd.spawn().map_err(|e| format!("啟動失敗：{e}"))?;
            let stdin = child.stdin.take().ok_or("無法取得 stdin")?;
            let stdout = child.stdout.take().ok_or("無法取得 stdout")?;
            McpClientState::Stdio {
                stdin,
                reader: tokio::io::BufReader::new(stdout),
                _child: child,
                request_id: 0,
            }
        }
        "http" | "sse" | "streamable_http" => {
            if config.url.trim().is_empty() {
                return Err("未設定 URL".to_string());
            }
            McpClientState::Http {
                client: reqwest::Client::new(),
                url: config.url.trim().to_string(),
                request_id: 0,
            }
        }
        t => return Err(format!("不支援的 transport：{t}")),
    };

    client.send_json_rpc("initialize", serde_json::json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "ListAgent", "version": "0.1.0"}
    })).await?;

    // notifications/initialized (required by some stdio servers)
    if let McpClientState::Stdio { stdin, .. } = &mut client {
        let notif = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\",\"params\":{}}\n";
        stdin.write_all(notif.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
    }

    Ok(client)
}

fn mcp_tools_to_openai(tools: &[Value]) -> Vec<Value> {
    tools.iter().filter_map(|t| {
        let name = t.get("name")?.as_str()?;
        Some(serde_json::json!({
            "type": "function",
            "function": {
                "name": name,
                "description": t.get("description").and_then(Value::as_str).unwrap_or(""),
                "parameters": t.get("inputSchema").cloned()
                    .unwrap_or(serde_json::json!({"type":"object","properties":{}}))
            }
        }))
    }).collect()
}

#[tauri::command]
async fn list_mcp_server_tools(server: McpServerConfig, working_directory: String) -> Result<Vec<McpToolInfo>, String> {
    let mut client = init_mcp_client(&server, &working_directory).await?;
    let tools = client.list_tools().await?;
    Ok(tools.iter().filter_map(|t| {
        let name = t.get("name")?.as_str()?.to_string();
        let description = t.get("description").and_then(Value::as_str).unwrap_or("").to_string();
        Some(McpToolInfo { name, description })
    }).collect())
}

fn load_memory_messages(working_directory: &str, item_code: &str) -> Vec<Value> {
    let dir = session_base_dir(working_directory, item_code);
    if !dir.exists() { return vec![]; }

    let mut sessions: Vec<(u64, PathBuf)> = match fs::read_dir(&dir) {
        Ok(rd) => rd.flatten().filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") { return None; }
            if !entry.file_name().to_string_lossy().starts_with("session_") { return None; }
            let modified = entry.metadata().ok()?.modified().ok()?
                .duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
            Some((modified, path))
        }).collect(),
        Err(_) => return vec![],
    };
    if sessions.is_empty() { return vec![]; }
    sessions.sort_by(|a, b| b.0.cmp(&a.0));

    let content = match fs::read_to_string(&sessions[0].1) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let session: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let exchanges = match session.get("exchanges").and_then(Value::as_array) {
        Some(e) => e,
        None => return vec![],
    };

    // Extract previous user input from round 1 request
    let user_input = exchanges.iter()
        .find(|ex| {
            ex.get("phase").and_then(Value::as_str) == Some("request") &&
            ex.get("round").and_then(Value::as_u64) == Some(1)
        })
        .and_then(|ex| ex.pointer("/payload/messages"))
        .and_then(Value::as_array)
        .and_then(|msgs| msgs.iter().find(|msg| {
            msg.get("_source").and_then(Value::as_str) == Some("📨 使用者輸入")
        }))
        .and_then(|msg| msg.get("content").and_then(Value::as_str))
        .map(str::to_string);

    // Extract final assistant text response (last response exchange with non-empty content)
    let final_response = exchanges.iter().rev()
        .find(|ex| {
            ex.get("phase").and_then(Value::as_str) == Some("response") &&
            ex.pointer("/payload/body/choices/0/message/content")
                .and_then(Value::as_str)
                .map(|s| !s.is_empty())
                .unwrap_or(false)
        })
        .and_then(|ex| ex.pointer("/payload/body/choices/0/message/content"))
        .and_then(Value::as_str)
        .map(str::to_string);

    match (user_input, final_response) {
        (Some(user), Some(assistant)) => vec![
            serde_json::json!({"role": "user", "content": user}),
            serde_json::json!({"role": "assistant", "content": assistant}),
        ],
        _ => vec![],
    }
}

fn tool_chat_endpoint(base_url: &str) -> Result<String, String> {
    if base_url.ends_with("/chat/completions") {
        return Ok(base_url.to_string());
    }
    if base_url.ends_with("/api/v1") || base_url.ends_with("/api/v1/chat") {
        let mut url =
            reqwest::Url::parse(base_url).map_err(|error| format!("API URL 無效：{error}"))?;
        url.set_path("/v1/chat/completions");
        url.set_query(None);
        return Ok(url.to_string());
    }
    Ok(format!("{base_url}/chat/completions"))
}

async fn execute_agent_with_tools(
    app_handle: &tauri::AppHandle,
    request: &AgentExecutionRequest,
    base_url: &str,
    input: String,
    has_parameters: bool,
) -> Result<AgentExecutionResult, String> {
    let endpoint = tool_chat_endpoint(base_url)?;
    let builtin_tool_definitions = tool_definitions(&request.tools)?;
    let workspace_root = tool_workspace_root(&request.working_directory)?;

    // Connect to MCP servers and collect their tools
    let mut mcp_clients: Vec<(String, McpClientState)> = Vec::new();
    // tool_name -> index into mcp_clients
    let mut mcp_tool_map: HashMap<String, usize> = HashMap::new();
    let mut mcp_tool_definitions: Vec<Value> = Vec::new();
    let workspace_str = workspace_root.to_str().unwrap_or("");
    for server in &request.mcp_servers {
        if !server.enabled { continue; }
        match init_mcp_client(server, workspace_str).await {
            Ok(mut client) => {
                match client.list_tools().await {
                    Ok(tools) => {
                        let idx = mcp_clients.len();
                        let openai_tools_all = mcp_tools_to_openai(&tools);
                        let openai_tools: Vec<Value> = if request.selected_mcp_tools.is_empty() {
                            openai_tools_all
                        } else {
                            openai_tools_all.into_iter().filter(|t| {
                                let name = t.pointer("/function/name").and_then(Value::as_str).unwrap_or("");
                                // selected_mcp_tools uses "serverName::toolName" format (set by frontend)
                                let qualified = format!("{}::{}", server.name, name);
                                request.selected_mcp_tools.contains(&qualified)
                            }).collect()
                        };
                        for t in &openai_tools {
                            if let Some(name) = t.pointer("/function/name").and_then(Value::as_str) {
                                mcp_tool_map.insert(name.to_string(), idx);
                            }
                        }
                        mcp_tool_definitions.extend(openai_tools);
                        mcp_clients.push((server.name.clone(), client));
                    }
                    Err(e) => eprintln!("MCP {} tools/list 失敗：{e}", server.name),
                }
            }
            Err(e) => eprintln!("MCP {} 初始化失敗：{e}", server.name),
        }
    }
    let mut tool_definitions = builtin_tool_definitions;
    tool_definitions.extend(mcp_tool_definitions);
    let has_user_prompt = has_parameters && !request.prompt.trim().is_empty();
    let skill_prompts = load_skill_prompts(&request.skills);
    let memory_history = if request.memory && !request.item_code.is_empty() {
        load_memory_messages(&request.working_directory, &request.item_code)
    } else {
        vec![]
    };
    let mut messages = Vec::new();
    if has_user_prompt {
        messages.push(serde_json::json!({ "role": "system", "content": request.prompt }));
    }
    for (_, skill_content) in &skill_prompts {
        messages.push(serde_json::json!({ "role": "system", "content": skill_content }));
    }
    messages.push(serde_json::json!({ "role": "system", "content": format!(
        "You are a tool-executing coding agent. When the user asks to create, inspect, search, or modify files, you MUST call the available tools and complete the work in the workspace. Do not merely print proposed code instead of using tools. File tools are restricted to this workspace root: {}. Use workspace-relative paths.",
        workspace_root.display()
    ) }));
    messages.extend(memory_history.iter().cloned());
    messages.push(serde_json::json!({ "role": "user", "content": input }));

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|error| format!("無法建立 HTTP client：{error}"))?;
    let mut execution_logs = Vec::new();
    // Some thinking/reasoning models (e.g. DeepSeek) don't support tool_choice="required".
    // Start with "required" and fall back to "auto" if the API rejects it.
    let mut tool_choice_required = true;
    let mut round_index = 0usize;
    while round_index < MAX_TOOL_ITERATIONS {
        let round = round_index + 1;
        let tool_choice = if execution_logs.is_empty() && tool_choice_required {
            "required"
        } else {
            "auto"
        };
        let mut body = serde_json::json!({
            "model": request.model_name,
            "messages": messages.clone(),
            "tools": tool_definitions.clone(),
            "tool_choice": tool_choice,
            "stream": false
        });
        if base_url.ends_with("/api/v1") || base_url.ends_with("/api/v1/chat") {
            // Gemma 4 reasoning markers can be misread by LM Studio's tool parser.
            body["reasoning"] = Value::String("off".to_string());
        }
        // Build annotated copy for logging (actual request uses body without _source)
        let mut emit_body = body.clone();
        if let Some(msgs) = emit_body["messages"].as_array_mut() {
            // Layout: [user_prompt?] [skill_0..n?] [agent_instruction] [memory_0..n?] [user_input] [history...]
            let skill_count = skill_prompts.len();
            let agent_instr_idx = (has_user_prompt as usize) + skill_count;
            let memory_count = memory_history.len();
            let user_input_idx = agent_instr_idx + 1 + memory_count;
            for (i, msg) in msgs.iter_mut().enumerate() {
                let source = if has_user_prompt && i == 0 {
                    "📝 項目 Prompt".to_string()
                } else if i >= (has_user_prompt as usize) && i < (has_user_prompt as usize) + skill_count {
                    let skill_idx = i - (has_user_prompt as usize);
                    format!("📦 Skill：{}", skill_prompts[skill_idx].0)
                } else if i == agent_instr_idx {
                    "🤖 Agent 內建指令".to_string()
                } else if memory_count > 0 && i > agent_instr_idx && i < user_input_idx {
                    "🧠 記憶歷史".to_string()
                } else if i == user_input_idx {
                    "📨 使用者輸入".to_string()
                } else {
                    "💬 對話歷史".to_string()
                };
                msg["_source"] = Value::String(source);
            }
        }
        emit_model_exchange(
            app_handle,
            request,
            round,
            "request",
            &endpoint,
            emit_body,
        );
        let build_request = || {
            let mut req = client.post(&endpoint).json(&body);
            if !request.api_key.trim().is_empty() {
                req = req.bearer_auth(request.api_key.trim());
            }
            req
        };
        let send_result = match build_request().send().await {
            Err(ref e) if !e.is_timeout() && (e.is_connect() || e.is_request()) => {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                build_request().send().await
            }
            other => other,
        };
        let response = match send_result {
            Ok(response) => response,
            Err(error) => {
                emit_model_exchange(
                    app_handle,
                    request,
                    round,
                    "error",
                    &endpoint,
                    serde_json::json!({ "message": error.to_string() }),
                );
                return Err(format!("無法連線至 {endpoint}：{error}"));
            }
        };
        let status = response.status();
        let response_body = response
            .text()
            .await
            .map_err(|error| format!("無法讀取模型回應：{error}"))?;
        let response_payload = serde_json::from_str(&response_body)
            .unwrap_or_else(|_| serde_json::json!({ "raw": response_body.clone() }));
        emit_model_exchange(
            app_handle,
            request,
            round,
            "response",
            &endpoint,
            serde_json::json!({ "status": status.as_u16(), "body": response_payload }),
        );
        if !status.is_success() {
            // Thinking models (e.g. DeepSeek) reject tool_choice="required";
            // silently retry this round with "auto".
            if status.as_u16() == 400
                && tool_choice_required
                && execution_logs.is_empty()
                && response_body.contains("tool_choice")
            {
                tool_choice_required = false;
                continue; // round_index NOT incremented → retries same round
            }
            return Err(format!("模型 API 回傳 {status}：{response_body}"));
        }
        let json: Value = serde_json::from_str(&response_body)
            .map_err(|error| format!("模型回應不是有效 JSON：{error}；內容：{response_body}"))?;
        let latest_stats = json.get("usage").cloned();
        let message = json
            .pointer("/choices/0/message")
            .cloned()
            .ok_or_else(|| format!("模型回應缺少 choices[0].message：{response_body}"))?;
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if tool_calls.is_empty() {
            let content = message
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            return Ok(AgentExecutionResult {
                endpoint,
                content: if content.is_empty() {
                    serde_json::to_string_pretty(&message).unwrap_or(response_body)
                } else {
                    content
                },
                stats: latest_stats,
                tool_calls: execution_logs,
            });
        }

        messages.push(message);
        for tool_call in tool_calls {
            let call_id = tool_call
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "tool call 缺少 id".to_string())?;
            let name = tool_call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .ok_or_else(|| "tool call 缺少 function.name".to_string())?;
            let raw_arguments = tool_call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let arguments: Value = serde_json::from_str(raw_arguments)
                .map_err(|error| format!("工具 {name} 的參數不是有效 JSON：{error}"))?;
            let result = if request.tools.iter().any(|enabled| enabled == name) {
                execute_tool(Some(app_handle), &workspace_root, name, &arguments)
                    .unwrap_or_else(|error| format!("Error: {error}"))
            } else if let Some(&client_idx) = mcp_tool_map.get(name) {
                if let Some((server_name, client)) = mcp_clients.get_mut(client_idx) {
                    client.call_tool(name, &arguments).await
                        .unwrap_or_else(|e| format!("Error: MCP {server_name} / {name} 失敗：{e}"))
                } else {
                    format!("Error: MCP client 不存在：{name}")
                }
            } else {
                format!("Error: 工具未啟用或不存在：{name}")
            };
            emit_model_exchange(
                app_handle,
                request,
                round,
                "tool",
                &endpoint,
                serde_json::json!({
                    "name": name,
                    "arguments": arguments.clone(),
                    "result": result.clone()
                }),
            );
            execution_logs.push(ToolExecutionLog {
                name: name.to_string(),
                arguments,
                result: result.clone(),
            });
            messages.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result
            }));
        }
        round_index += 1;
    }

    Err(format!("工具呼叫超過 {MAX_TOOL_ITERATIONS} 輪，已停止執行"))
}

#[tauri::command]
async fn execute_agent(
    app_handle: tauri::AppHandle,
    request: AgentExecutionRequest,
) -> Result<AgentExecutionResult, String> {
    let base_url = request.api_base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("尚未設定 API URL".to_string());
    }
    if request.model_name.trim().is_empty() {
        return Err("尚未設定 Model Name".to_string());
    }

    let is_lm_studio_native = base_url.ends_with("/api/v1") || base_url.ends_with("/api/v1/chat");
    let endpoint = if base_url.ends_with("/chat") || base_url.ends_with("/chat/completions") {
        base_url.to_string()
    } else if is_lm_studio_native {
        format!("{base_url}/chat")
    } else {
        format!("{base_url}/chat/completions")
    };

    let has_parameters = request.parameters.is_some();
    let input = match request.parameters.as_ref() {
        Some(Value::String(value)) => value.clone(),
        Some(value) => serde_json::to_string_pretty(value).map_err(|error| error.to_string())?,
        None if !request.prompt.trim().is_empty() => request.prompt.clone(),
        None => return Err("沒有可傳送的 Prompt 或 HTTP 輸入參數".to_string()),
    };

    if !request.tools.is_empty() || request.mcp_servers.iter().any(|s| s.enabled) {
        return execute_agent_with_tools(&app_handle, &request, base_url, input, has_parameters)
            .await;
    }

    let has_user_prompt = has_parameters && !request.prompt.trim().is_empty();
    let skill_prompts = load_skill_prompts(&request.skills);
    let body = if is_lm_studio_native {
        let mut body = serde_json::json!({
            "model": request.model_name,
            "input": input,
            "store": false
        });
        if has_user_prompt {
            body["system_prompt"] = Value::String(request.prompt.clone());
        }
        // LM Studio native does not support multiple system prompts; concatenate skills
        if !skill_prompts.is_empty() {
            let combined = skill_prompts
                .iter()
                .map(|(_, c)| c.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let existing = body["system_prompt"].as_str().unwrap_or("").to_string();
            let merged = if existing.is_empty() { combined } else { format!("{existing}\n\n{combined}") };
            body["system_prompt"] = Value::String(merged);
        }
        body
    } else {
        let mut messages = Vec::new();
        if has_user_prompt {
            messages
                .push(serde_json::json!({ "role": "system", "content": request.prompt.clone() }));
        }
        for (_, skill_content) in &skill_prompts {
            messages.push(serde_json::json!({ "role": "system", "content": skill_content }));
        }
        messages.push(serde_json::json!({ "role": "user", "content": input }));
        serde_json::json!({
            "model": request.model_name,
            "messages": messages,
            "stream": false
        })
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|error| format!("無法建立 HTTP client：{error}"))?;
    // Build annotated copy for logging (actual request uses body without _source)
    let mut emit_body = body.clone();
    if let Some(msgs) = emit_body["messages"].as_array_mut() {
        let skill_count = skill_prompts.len();
        let user_input_idx = (has_user_prompt as usize) + skill_count;
        for (i, msg) in msgs.iter_mut().enumerate() {
            let source = if has_user_prompt && i == 0 {
                "📝 項目 Prompt".to_string()
            } else if i >= (has_user_prompt as usize) && i < (has_user_prompt as usize) + skill_count {
                let skill_idx = i - (has_user_prompt as usize);
                format!("📦 Skill：{}", skill_prompts[skill_idx].0)
            } else if i == user_input_idx {
                "📨 使用者輸入".to_string()
            } else {
                "💬 對話歷史".to_string()
            };
            msg["_source"] = Value::String(source);
        }
    }
    if is_lm_studio_native {
        if has_user_prompt || !skill_prompts.is_empty() {
            let mut sources = Vec::new();
            if has_user_prompt { sources.push("📝 項目 Prompt"); }
            for _ in &skill_prompts { sources.push("📦 Skill"); }
            emit_body["_system_prompt_source"] = Value::String(sources.join(" + "));
        }
        emit_body["_input_source"] = Value::String("📨 使用者輸入".to_string());
    }
    emit_model_exchange(&app_handle, &request, 1, "request", &endpoint, emit_body);
    let build_request = || {
        let mut req = client.post(&endpoint).json(&body);
        if !request.api_key.trim().is_empty() {
            req = req.bearer_auth(request.api_key.trim());
        }
        req
    };
    let send_result = match build_request().send().await {
        Err(ref e) if !e.is_timeout() && (e.is_connect() || e.is_request()) => {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            build_request().send().await
        }
        other => other,
    };
    let response = match send_result {
        Ok(response) => response,
        Err(error) => {
            emit_model_exchange(
                &app_handle,
                &request,
                1,
                "error",
                &endpoint,
                serde_json::json!({ "message": error.to_string() }),
            );
            return Err(format!("無法連線至 {endpoint}：{error}"));
        }
    };
    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|error| format!("無法讀取模型回應：{error}"))?;
    let response_payload = serde_json::from_str(&response_body)
        .unwrap_or_else(|_| serde_json::json!({ "raw": response_body.clone() }));
    emit_model_exchange(
        &app_handle,
        &request,
        1,
        "response",
        &endpoint,
        serde_json::json!({ "status": status.as_u16(), "body": response_payload }),
    );
    if !status.is_success() {
        return Err(format!("模型 API 回傳 {status}：{response_body}"));
    }

    let json: Value = serde_json::from_str(&response_body)
        .map_err(|error| format!("模型回應不是有效 JSON：{error}；內容：{response_body}"))?;
    let content = if is_lm_studio_native {
        json.get("output")
            .and_then(Value::as_array)
            .map(|outputs| {
                outputs
                    .iter()
                    .filter(|output| output.get("type").and_then(Value::as_str) == Some("message"))
                    .filter_map(|output| output.get("content").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    } else {
        json.pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    Ok(AgentExecutionResult {
        endpoint,
        content: if content.is_empty() {
            serde_json::to_string_pretty(&json).unwrap_or(response_body)
        } else {
            content
        },
        stats: json
            .get("stats")
            .cloned()
            .or_else(|| json.get("usage").cloned()),
        tool_calls: Vec::new(),
    })
}

fn write_http_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn decode_query_component(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'+' => decoded.push(b' '),
            b'%' => {
                if index + 2 >= bytes.len() {
                    return Err("query string 的百分比編碼無效".to_string());
                }
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                    .map_err(|_| "query string 的百分比編碼無效".to_string())?;
                decoded.push(
                    u8::from_str_radix(hex, 16)
                        .map_err(|_| "query string 的百分比編碼無效".to_string())?,
                );
                index += 2;
            }
            byte => decoded.push(byte),
        }
        index += 1;
    }

    String::from_utf8(decoded).map_err(|_| "query string 不是有效的 UTF-8".to_string())
}

fn parse_get_input(request_path: &str) -> Result<HttpInput, String> {
    let query = request_path
        .split_once('?')
        .map(|(_, query)| query)
        .ok_or_else(|| "GET /input 必須包含 query string".to_string())?;
    let mut agent = None;
    let mut parameters = serde_json::Map::new();

    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode_query_component(raw_key)?;
        let value = decode_query_component(raw_value)?;

        if key == "agent" {
            agent = Some(value);
            continue;
        }

        match parameters.get_mut(&key) {
            Some(Value::Array(values)) => values.push(Value::String(value)),
            Some(existing) => {
                let previous = std::mem::replace(existing, Value::Null);
                *existing = Value::Array(vec![previous, Value::String(value)]);
            }
            None => {
                parameters.insert(key, Value::String(value));
            }
        }
    }

    Ok(HttpInput {
        agent: agent.ok_or_else(|| "GET /input 缺少 agent 參數".to_string())?,
        parameters: Value::Object(parameters),
    })
}

fn parse_post_input(body: &[u8]) -> Result<HttpInput, String> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| "body 必須是有效的 JSON，並包含 agent".to_string())?;
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| "body 必須是 JSON object".to_string())?;
    let agent = object
        .remove("agent")
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or_else(|| "body 缺少字串欄位 agent".to_string())?;
    let parameters = object
        .remove("parameters")
        .or_else(|| object.remove("params"))
        .or_else(|| object.remove("input"))
        .unwrap_or(Value::Object(object));
    Ok(HttpInput { agent, parameters })
}

fn handle_http_connection(
    mut stream: TcpStream,
    queue: &HttpInputQueue,
    app_handle: &tauri::AppHandle,
) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));

    let parsed_request = (|| -> Result<(String, String, Vec<u8>), String> {
        let mut reader = BufReader::new(&mut stream);
        let mut request_line = String::new();
        reader
            .read_line(&mut request_line)
            .map_err(|_| "無法讀取 request line".to_string())?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let path = parts.next().unwrap_or_default().to_string();
        if method.is_empty() || path.is_empty() {
            return Err("無效的 HTTP request".to_string());
        }

        let mut content_length = 0usize;
        loop {
            let mut header = String::new();
            reader
                .read_line(&mut header)
                .map_err(|_| "無法讀取 HTTP headers".to_string())?;
            if header == "\r\n" || header == "\n" || header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = value
                        .trim()
                        .parse()
                        .map_err(|_| "Content-Length 無效".to_string())?;
                }
            }
        }

        if content_length > MAX_REQUEST_BODY_SIZE {
            return Err("request body 超過 1 MB".to_string());
        }

        let mut body = vec![0; content_length];
        reader
            .read_exact(&mut body)
            .map_err(|_| "request body 不完整".to_string())?;
        Ok((method, path, body))
    })();

    let (method, path, body) = match parsed_request {
        Ok(request) => request,
        Err(message) => {
            let body = serde_json::json!({ "error": message }).to_string();
            write_http_response(&mut stream, "400 Bad Request", &body);
            return;
        }
    };

    let endpoint = path.split('?').next().unwrap_or(&path);
    if method == "OPTIONS" {
        write_http_response(&mut stream, "204 No Content", "");
        return;
    }
    if method == "GET" && endpoint == "/health" {
        write_http_response(&mut stream, "200 OK", r#"{"status":"ok"}"#);
        return;
    }
    // Check if HTTP trigger is enabled in settings
    if let Ok(settings) = read_settings() {
        if !settings.enable_http_input {
            let response = serde_json::json!({ "error": "HTTP trigger is disabled in event settings" }).to_string();
            write_http_response(&mut stream, "403 Forbidden", &response);
            return;
        }
    }
    if endpoint != "/input" {
        write_http_response(
            &mut stream,
            "404 Not Found",
            r#"{"error":"找不到 endpoint"}"#,
        );
        return;
    }
    let parsed_input = match method.as_str() {
        "GET" => parse_get_input(&path),
        "POST" => parse_post_input(&body),
        _ => {
            write_http_response(
                &mut stream,
                "405 Method Not Allowed",
                r#"{"error":"/input 僅接受 GET 或 POST"}"#,
            );
            return;
        }
    };
    let mut input: HttpInput = match parsed_input {
        Ok(input) => input,
        Err(message) => {
            let response = serde_json::json!({ "error": message }).to_string();
            write_http_response(&mut stream, "400 Bad Request", &response);
            return;
        }
    };
    input.agent = input.agent.trim().to_string();
    if input.agent.is_empty() || input.agent.chars().count() > 200 {
        write_http_response(
            &mut stream,
            "400 Bad Request",
            r#"{"error":"agent 必須是 1 至 200 字元的項目名稱"}"#,
        );
        return;
    }

    if let Ok(mut pending) = queue.0.lock() {
        if pending.len() >= MAX_QUEUED_INPUTS {
            pending.pop_front();
        }
        pending.push_back(input.clone());
    } else {
        write_http_response(
            &mut stream,
            "500 Internal Server Error",
            r#"{"error":"輸入佇列暫時無法使用"}"#,
        );
        return;
    }

    let _ = app_handle.emit("http-input-available", ());
    let response = serde_json::json!({ "accepted": true, "agent": input.agent }).to_string();
    write_http_response(&mut stream, "202 Accepted", &response);
}

fn start_http_server(queue: HttpInputQueue, app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(HTTP_SERVER_ADDRESS) {
            Ok(listener) => listener,
            Err(error) => {
                log::error!("HTTP server 無法啟動於 {HTTP_SERVER_ADDRESS}: {error}");
                return;
            }
        };

        log::info!("HTTP server 已啟動：http://{HTTP_SERVER_ADDRESS}");
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let connection_queue = queue.clone();
                    let connection_app_handle = app_handle.clone();
                    thread::spawn(move || {
                        handle_http_connection(stream, &connection_queue, &connection_app_handle)
                    });
                }
                Err(error) => log::warn!("HTTP connection 失敗: {error}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_input_uses_agent_and_collects_remaining_query_parameters() {
        let input =
            parse_get_input("/input?agent=%E6%91%98%E8%A6%81%E5%8A%A9%E6%89%8B&message=%E4%BD%A0%E5%A5%BD&tag=first&tag=second")
                .unwrap();

        assert_eq!(input.agent, "摘要助手");
        assert_eq!(input.parameters["message"], "你好");
        assert_eq!(
            input.parameters["tag"],
            serde_json::json!(["first", "second"])
        );
    }

    #[test]
    fn get_input_requires_agent() {
        assert!(parse_get_input("/input?message=hello").is_err());
    }

    #[test]
    fn post_input_accepts_top_level_arg_fields() {
        let body = r#"{"agent":"摘要助手","arg1":"alpha","arg2":2,"arg3":{"ok":true}}"#;
        let input = parse_post_input(body.as_bytes()).unwrap();

        assert_eq!(input.agent, "摘要助手");
        assert_eq!(input.parameters["arg1"], "alpha");
        assert_eq!(input.parameters["arg2"], 2);
        assert_eq!(input.parameters["arg3"]["ok"], true);
    }

    #[test]
    fn old_settings_without_events_remain_compatible() {
        let settings: Settings =
            serde_json::from_str(r#"{"items":[],"userPresets":[],"builtinPresets":[]}"#).unwrap();
        assert!(settings.events.is_empty());
    }

    #[test]
    fn scheduled_event_uses_camel_case_fields() {
        let event = ScheduledEvent {
            id: "event-1".to_string(),
            trigger_at: 1_800_000_000_000,
            agent_id: 7,
            recurrence: "interval".to_string(),
            interval_seconds: Some(3600),
            executed_at: Some(1_799_999_000_000),
            execution_count: 3,
        };
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["triggerAt"], 1_800_000_000_000u64);
        assert_eq!(json["agentId"], 7);
        assert_eq!(json["intervalSeconds"], 3600);
        assert_eq!(json["executionCount"], 3);
    }

    #[test]
    fn lm_studio_native_url_maps_to_tool_calling_endpoint() {
        assert_eq!(
            tool_chat_endpoint("http://127.0.0.1:1234/api/v1").unwrap(),
            "http://127.0.0.1:1234/v1/chat/completions"
        );
    }

    #[test]
    fn file_tools_write_read_search_replace_and_list_inside_workspace() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        let unique = format!(
            "target/tool-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let directory = root.join(&unique);
        fs::create_dir_all(&directory).unwrap();

        let result = (|| -> Result<(), String> {
            let file = format!("{unique}/sample.txt");
            execute_tool(
                None,
                &root,
                "write_file",
                &serde_json::json!({ "path": file.clone(), "content": "hello tool" }),
            )?;
            assert_eq!(
                execute_tool(
                    None,
                    &root,
                    "read_file",
                    &serde_json::json!({ "path": file.clone() })
                )?,
                "hello tool"
            );
            let search = execute_tool(
                None,
                &root,
                "search_content",
                &serde_json::json!({ "path": unique.clone(), "query": "TOOL" }),
            )?;
            assert!(search.contains("sample.txt"));
            execute_tool(
                None,
                &root,
                "replace_string",
                &serde_json::json!({
                    "path": file.clone(),
                    "old_string": "hello",
                    "new_string": "goodbye"
                }),
            )?;
            assert_eq!(
                execute_tool(None, &root, "read_file", &serde_json::json!({ "path": file }))?,
                "goodbye tool"
            );
            let listing = execute_tool(
                None,
                &root,
                "list_directory",
                &serde_json::json!({ "path": unique }),
            )?;
            assert!(listing.contains("sample.txt"));
            Ok(())
        })();

        fs::remove_dir_all(directory).unwrap();
        result.unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let input_queue = HttpInputQueue::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(input_queue.clone())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            start_http_server(input_queue, app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_settings,
            write_settings,
            take_http_inputs,
            execute_agent,
            save_session,
            list_sessions,
            read_session_file,
            list_skills,
            list_mcp_server_tools
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
