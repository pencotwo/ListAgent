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
const DEFAULT_COMMAND_TIMEOUT_SECONDS: u64 = 30;
const MAX_COMMAND_TIMEOUT_SECONDS: u64 = 7200;
fn default_max_rounds() -> u32 {
    100
}
const MAX_TOOL_FILE_SIZE: u64 = 1024 * 1024;
const READ_FILE_DEFAULT_LIMIT: usize = 2000;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_FILES: usize = 5000;
const MAX_SEARCH_DURATION_MS: u64 = 8000;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HttpInput {
    #[serde(default)]
    pub agent: String, // Item name (backward compat / human-readable)
    #[serde(default, rename = "agentId")]
    pub agent_id: String, // Stable, unique per-item identifier (preferred)
    #[serde(default)]
    pub action: String, // "run" (default) | "get_status" | "list_agents"
    #[serde(default, rename = "execId")]
    pub exec_id: String, // Client-supplied ID for correlating request → agent execution
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default, alias = "params", alias = "input")]
    pub parameters: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentTaskDetail {
    #[serde(
        rename = "currentRound",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub current_round: Option<u32>,
    #[serde(
        rename = "currentTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub current_tokens: Option<u64>,
    #[serde(
        rename = "lastEndedAt",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_ended_at: Option<u64>,
    #[serde(
        rename = "lastSuccess",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_success: Option<bool>,
    #[serde(
        rename = "lastContentPreview",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_content_preview: Option<String>,
    #[serde(
        rename = "lastTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_tokens: Option<u64>,
    #[serde(
        rename = "lastRounds",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_rounds: Option<u32>,
    #[serde(
        rename = "currentExecId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub current_exec_id: Option<String>,
    #[serde(
        rename = "lastExecId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_exec_id: Option<String>,
    #[serde(
        rename = "lastSessionPath",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_session_path: Option<String>,
    #[serde(
        rename = "lastSessionUrl",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_session_url: Option<String>,
    #[serde(
        rename = "lastPromptTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_prompt_tokens: Option<u64>,
    #[serde(
        rename = "lastCachedTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_cached_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct AgentStatusSnapshot {
    pub running: Vec<String>,         // agent names currently running
    pub queued: HashMap<String, u32>, // agent name → queue length
    #[serde(default)]
    pub detail: HashMap<String, AgentTaskDetail>, // agent name → task detail
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
}

fn agent_status() -> &'static std::sync::Mutex<AgentStatusSnapshot> {
    static INSTANCE: std::sync::OnceLock<std::sync::Mutex<AgentStatusSnapshot>> =
        std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| std::sync::Mutex::new(AgentStatusSnapshot::default()))
}

fn pending_agent_messages() -> &'static std::sync::Mutex<HashMap<u32, Vec<String>>> {
    static INSTANCE: std::sync::OnceLock<std::sync::Mutex<HashMap<u32, Vec<String>>>> =
        std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[tauri::command]
#[allow(non_snake_case)]
fn send_agent_message(itemId: u32, message: String) {
    println!(
        ">>> backend received send_agent_message: itemId={}, message='{}'",
        itemId, message
    );
    if let Ok(mut map) = pending_agent_messages().lock() {
        map.entry(itemId).or_default().push(message);
    }
}

fn pause_requests() -> &'static std::sync::Mutex<std::collections::HashSet<u32>> {
    static INSTANCE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<u32>>> =
        std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// 標記某 item 在跑完目前這一輪 tool-calling 之後暫停執行。
#[tauri::command]
#[allow(non_snake_case)]
fn request_pause_agent(itemId: u32) {
    if let Ok(mut set) = pause_requests().lock() {
        set.insert(itemId);
    }
}

/// 取消尚未生效的暫停請求（例如使用者按了暫停又立刻反悔）。
#[tauri::command]
#[allow(non_snake_case)]
fn cancel_pause_request(itemId: u32) {
    if let Ok(mut set) = pause_requests().lock() {
        set.remove(&itemId);
    }
}

/// 將 var_name 視為環境變數名稱，讀取對應的值。
fn resolve_env_key(var_name: &str) -> String {
    let trimmed = var_name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(value) = std::env::var(trimmed) {
        return value;
    }
    #[cfg(windows)]
    {
        for key in [
            r"HKCU\Environment",
            r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ] {
            if let Ok(output) = std::process::Command::new("reg")
                .args(["query", key, "/v", trimmed])
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    for line in stdout.lines() {
                        let mut parts = line.split_whitespace();
                        if parts.next() == Some(trimmed) {
                            let value_type = parts.next().unwrap_or_default();
                            if value_type == "REG_SZ" || value_type == "REG_EXPAND_SZ" {
                                let value = parts.collect::<Vec<_>>().join(" ");
                                if !value.is_empty() {
                                    return value;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    String::new()
}

#[tauri::command]
fn update_agent_status(
    running: Vec<String>,
    queued: HashMap<String, u32>,
    detail: HashMap<String, AgentTaskDetail>,
) {
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Ok(mut s) = agent_status().lock() {
        s.running = running;
        s.queued = queued;
        s.detail = detail;
        s.updated_at = updated_at;
    }
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

fn bool_true() -> bool {
    true
}

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
    #[serde(default = "default_max_rounds")]
    #[serde(rename = "maxRounds")]
    max_rounds: u32,
    #[serde(default)]
    tools_search: bool,
    /// 從暫停狀態繼續執行時，帶回上次中斷點累積的完整對話訊息（含 tool 呼叫/結果）。
    #[serde(default, rename = "resumeMessages")]
    resume_messages: Option<Vec<Value>>,
    /// 從暫停狀態繼續執行時，帶回上次中斷時已完成的輪數，接續編號。
    #[serde(default, rename = "resumeRound")]
    resume_round: Option<u32>,
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
    #[serde(default)]
    paused: bool,
    /// 暫停時的完整對話狀態（messages + roundIndex），交給前端存檔，繼續執行時原封傳回。
    #[serde(default, rename = "resumeState")]
    resume_state: Option<Value>,
    /// 模型 API 回應中回報的實際服務模型（例如 LM Studio 的 model_instance_id，
    /// 或 OpenAI 相容回應的 model 欄位）。用來讓前端偵測「請求的模型」與「實際執行的模型」
    /// 不一致的情況（常見於本機推論伺服器忽略 model 參數、改用當下已載入的模型）。
    #[serde(default)]
    actual_model: Option<String>,
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
    emit_model_exchange_for_item(app_handle, request.item_id, round, phase, endpoint, payload);
}

fn emit_model_exchange_for_item(
    app_handle: &tauri::AppHandle,
    item_id: u32,
    round: usize,
    phase: &str,
    endpoint: &str,
    payload: Value,
) {
    let _ = app_handle.emit(
        "model-exchange",
        ModelExchangeEvent {
            item_id,
            round,
            phase: phase.to_string(),
            endpoint: endpoint.to_string(),
            payload,
        },
    );
}

fn annotate_resumed_message_sources(messages: &mut [Value]) {
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let source = match role {
            "user" => "👤 使用者輸入",
            "system" => "🗜 壓縮上下文",
            "assistant" => "🗜 壓縮上下文",
            "tool" => "🗜 壓縮上下文工具結果",
            _ => "🗜 壓縮上下文",
        };
        message["_source"] = Value::String(source.to_string());
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ListItem {
    pub id: u32,
    #[serde(default, rename = "agentId")]
    pub agent_id: String,
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
    #[serde(rename = "mcpTools")]
    pub mcp_tools: Vec<String>,
    #[serde(default)]
    pub memory: bool,
    #[serde(default)]
    #[serde(rename = "allowHttp")]
    pub allow_http: bool,
    #[serde(default = "default_max_rounds")]
    #[serde(rename = "maxRounds")]
    pub max_rounds: u32,
    #[serde(default)]
    #[serde(rename = "toolsSearch")]
    pub tools_search: bool,
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

fn agent_test_data_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".agent_test")
}

fn migrate_file_if_needed(filename: &str) -> PathBuf {
    let new_dir = agent_test_data_dir();
    let new_path = new_dir.join(filename);
    if !new_path.exists() {
        // Try to find it in the old path (repo root in dev, or next to exe in release)
        let old_dir = if cfg!(debug_assertions) {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest
                .ancestors()
                .nth(2)
                .map(|p| p.to_path_buf())
                .unwrap_or(manifest)
        } else {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."))
        };
        let old_path = old_dir.join(filename);
        if old_path.exists() {
            let _ = fs::create_dir_all(&new_dir);
            let _ = fs::copy(&old_path, &new_path);
        }
    }
    new_path
}

fn agent_test_history_path() -> PathBuf {
    migrate_file_if_needed("agent_test.json")
}

fn agent_test_autolist_path() -> PathBuf {
    migrate_file_if_needed("agent_test_autolist.json")
}

fn skills_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        // Dev: point to the app project root (parent of src-tauri) so devs can
        // edit skills without digging into target/debug.
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        return manifest
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or(manifest)
            .join("skills");
    }
    // Release: next to the installed executable.
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("skills")
}

fn default_builtin_agent_instruction() -> String {
    "You are a tool-using coding agent.\n\
{now_line}\n\
{workspace_line}\n\
For build/run/test/execute/fix/verify requests, actually use tools unless the user asks only for instructions.\n\
Known scripts/commands such as build.bat: run directly with execute_command from workspace root; do not use search_content to find filenames.\n\
For long builds, set timeout_seconds 1800-7200.\n\
Follow tool next_step. When the requested task succeeds, stop calling tools and give the final result.\n\
When a tool fails because a path does not exist: use list_directory to explore the workspace structure first, then retry with the correct path. Never give up after a single path error — explore, find the correct path, and retry. If the user mentions a directory name, check whether it exists under the workspace root or use list_directory with path \".\" to see top-level entries."
        .to_string()
}

/// 內建系統提示詞設定（從 system_prompt.json 載入）。目前只有一個內建 agent 指令範本，
/// 其中 {now_line} / {workspace_line} 是執行時才知道的動態內容，用字串取代注入。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemPromptConfig {
    #[serde(default = "default_builtin_agent_instruction")]
    builtin_agent_instruction: String,
}

impl Default for SystemPromptConfig {
    fn default() -> Self {
        SystemPromptConfig {
            builtin_agent_instruction: default_builtin_agent_instruction(),
        }
    }
}

fn system_prompt_path() -> PathBuf {
    if cfg!(debug_assertions) {
        // Dev: repo root（與 release 時「exe 旁邊」的位置一致，方便直接編輯）。
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        return manifest
            .ancestors()
            .nth(2)
            .map(|p| p.to_path_buf())
            .unwrap_or(manifest)
            .join("system_prompt.json");
    }
    // Release: next to the installed executable.
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("system_prompt.json")
}

fn load_system_prompt_config() -> SystemPromptConfig {
    let path = system_prompt_path();
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<SystemPromptConfig>(&content) {
            Ok(config) => {
                println!("已載入 system prompt 設定：{}", path.display());
                config
            }
            Err(error) => {
                eprintln!("system_prompt.json 格式錯誤，改用內建預設值：{error}");
                SystemPromptConfig::default()
            }
        },
        Err(_) => {
            println!("找不到 {}，使用內建預設 system prompt", path.display());
            SystemPromptConfig::default()
        }
    }
}

/// App 啟動時載入一次並快取；之後每輪對話都重複使用同一份設定。
fn system_prompt_config() -> &'static SystemPromptConfig {
    static INSTANCE: std::sync::OnceLock<SystemPromptConfig> = std::sync::OnceLock::new();
    INSTANCE.get_or_init(load_system_prompt_config)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SkillFile {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

fn read_skill_file(id: &str, path: &Path) -> Option<(SkillMeta, String)> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed: SkillFile = serde_json::from_str(&raw).ok()?;
    // Prefer display_name for the shown name; fall back to name; then the id.
    let name = parsed
        .display_name
        .or(parsed.name)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| id.replace('-', " ").replace('_', " "));
    let description = {
        let raw_desc = parsed.description.unwrap_or_default();
        let trimmed = raw_desc.trim();
        if trimmed.chars().count() > 100 {
            let truncated: String = trimmed.chars().take(99).collect();
            format!("{truncated}…")
        } else {
            trimmed.to_string()
        }
    };
    // Accept both `prompt` and `system_prompt`.
    let prompt = parsed.system_prompt.or(parsed.prompt).unwrap_or_default();
    Some((
        SkillMeta {
            id: id.to_string(),
            name,
            description,
            version: parsed.version,
        },
        prompt,
    ))
}

#[tauri::command]
fn list_skills() -> Result<Vec<SkillMeta>, String> {
    let dir = skills_dir();
    if !dir.exists() {
        // Auto-create so users have an obvious place to drop *.json skills.
        let _ = fs::create_dir_all(&dir);
        return Ok(vec![]);
    }
    let mut skills: Vec<SkillMeta> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension()?.to_str()? != "json" {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            let (meta, _prompt) = read_skill_file(&id, &path)?;
            Some(meta)
        })
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

#[tauri::command]
fn read_skill(id: String) -> Result<serde_json::Value, String> {
    let dir = skills_dir();
    let path = dir.join(format!("{id}.json"));
    if !path.exists() {
        return Err("Skill file not found".to_string());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(parsed)
}

#[tauri::command]
fn save_skill(id: String, skill_data: serde_json::Value) -> Result<(), String> {
    let dir = skills_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let safe_id: String = id.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    if safe_id.is_empty() || safe_id != id {
        return Err("Invalid skill ID. Only letters, numbers, hyphens, and underscores are allowed.".to_string());
    }
    let path = dir.join(format!("{safe_id}.json"));
    let formatted = serde_json::to_string_pretty(&skill_data).map_err(|e| e.to_string())?;
    fs::write(&path, formatted).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_skill(id: String) -> Result<(), String> {
    let dir = skills_dir();
    let safe_id: String = id.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    if safe_id.is_empty() || safe_id != id {
        return Err("Invalid skill ID".to_string());
    }
    let path = dir.join(format!("{safe_id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn load_skill_entries(skills: &[String]) -> Vec<(SkillMeta, String)> {
    let dir = skills_dir();
    skills
        .iter()
        .filter_map(|id| {
            let path = dir.join(format!("{id}.json"));
            let (meta, prompt) = read_skill_file(id, &path)?;
            if prompt.trim().is_empty() {
                None
            } else {
                Some((meta, prompt))
            }
        })
        .collect()
}

fn load_skill_prompts(skills: &[String]) -> Vec<(String, String)> {
    load_skill_entries(skills)
        .into_iter()
        .map(|(meta, prompt)| (meta.name, prompt))
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
    if !wd.is_empty() {
        // With a working directory: all items in that workspace share a single
        // `session/` folder — subdir (item code) is ignored. Filtering by item
        // happens later when reading, via the itemId inside each session JSON.
        return PathBuf::from(wd).join(".ListAgent").join("session");
    }
    // No working directory → fall back to global per-item folder under HOME.
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".listagent")
        .join("sessions")
        .join(subdir)
}

/// Parse frontend's item code (base-36, uppercase, zero-padded to 4) back to numeric id.
fn parse_item_code(code: &str) -> Option<u32> {
    if code.is_empty() {
        return None;
    }
    u32::from_str_radix(code.trim(), 36).ok()
}

/// Read a session file's itemId (u64) without loading the whole exchanges array.
fn read_session_item_id(path: &Path) -> Option<u32> {
    let content = fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&content).ok()?;
    json.get("itemId").and_then(Value::as_u64).map(|v| v as u32)
}

#[tauri::command]
fn save_session(
    working_directory: String,
    subdir: String,
    filename: String,
    content: Value,
) -> Result<(), String> {
    let dir = session_base_dir(&working_directory, &subdir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);
    let content = serde_json::to_vec_pretty(&content).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
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
    // When the workspace shares a single session/ folder, filter by itemId
    // encoded in the frontend's item code (base-36).
    let filter_item_id = if !working_directory.trim().is_empty() {
        parse_item_code(&subdir)
    } else {
        None
    };
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
        if let Some(target_id) = filter_item_id {
            match read_session_item_id(&path) {
                Some(id) if id == target_id => {}
                _ => continue,
            }
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

/// Task-keyword aliases for built-in tools, used by search_tools_and_skills so natural-language
/// queries (e.g. "git", "run shell") reach tools whose name/description doesn't literally contain them.
fn builtin_tool_aliases(name: &str) -> &'static [&'static str] {
    match name {
        "list_directory" | "list_dir" => {
            &["folder", "directory", "files", "ls", "dir", "browse", "workspace"]
        }
        "search_content" | "grep_search" => {
            &["grep", "find", "search", "text", "content", "code", "keyword"]
        }
        "read_file" => &["file", "read", "load", "open", "content", "text"],
        "write_file" => &["file", "write", "save", "create", "output"],
        "replace_string" => &["edit", "modify", "change", "update", "patch"],
        "trigger_event" => &["event", "trigger", "notify", "signal", "hook", "call"],
        "web_search" => &[
            "web", "internet", "google", "search", "online", "news", "weather", "stock", "info",
            "lookup", "research", "query",
        ],
        "fetch_url" => &[
            "web", "url", "http", "https", "page", "site", "download", "get", "html", "scrape",
        ],
        "get_current_time" => &[
            "time", "date", "now", "today", "clock", "timezone", "current", "moment", "timestamp",
        ],
        "execute_command" => &[
            "command", "shell", "terminal", "run", "exec", "execute", "build", "git", "commit",
            "push", "npm", "cargo", "python", "script", "install", "test", "compile", "cmd",
            "powershell", "bash",
        ],
        _ => &[],
    }
}

fn tool_definitions(selected: &[String]) -> Result<Vec<Value>, String> {
    let defs: Result<Vec<Value>, String> = selected
        .iter()
        .map(|name| match name.as_str() {
            "list_directory" | "list_dir" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": name,
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
                    "description": "Recursively search UTF-8 file contents in the workspace. This searches inside files, not filenames. To locate or run a known script such as build.bat, prefer list_directory or execute_command.",
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
            "grep_search" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "grep_search",
                    "description": "Search file contents inside the workspace using a query string.",
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
                    "description": "Read a UTF-8 text file from the workspace. Returns at most 2000 lines per call — for larger files, page through with offset/limit instead of assuming the whole file fits in one call.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "offset": { "type": "integer", "description": "1-indexed line number to start reading from. Defaults to 1." },
                            "limit": { "type": "integer", "description": "Maximum number of lines to return. Defaults to 2000." }
                        },
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
            "web_search" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": "Perform a Google-like web search for the query and retrieve relevant results.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "The search query to look up on the web." }
                        },
                        "required": ["query"],
                        "additionalProperties": false
                    }
                }
            })),
            "fetch_url" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "fetch_url",
                    "description": "Fetch a URL and return its plain-text content (HTML tags/scripts stripped, truncated to ~8000 chars). Use this after web_search when you need the actual page content instead of a snippet.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "url": { "type": "string", "description": "Absolute http/https URL to fetch." }
                        },
                        "required": ["url"],
                        "additionalProperties": false
                    }
                }
            })),
            "get_current_time" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "get_current_time",
                    "description": "Get the current date and time. Use this whenever the user asks about 'now', 'today', 'current time', or when you need an accurate timestamp — do NOT guess based on training data. Call with NO arguments to use the app's default (system) timezone — this is the correct choice unless the user explicitly asked about a specific city/country's local time.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "timezone": {
                                "type": "string",
                                "description": "OPTIONAL. Only pass this when the user explicitly asks for a specific location's time (e.g. 'what time is it in New York'). Otherwise omit — the app defaults to the system timezone. IANA name, e.g. 'Asia/Taipei', 'UTC', 'America/New_York'."
                            }
                        },
                        "additionalProperties": false
                    }
                }
            })),
            "execute_command" => Ok(serde_json::json!({
                "type": "function",
                "function": {
                    "name": "execute_command",
                    "description": "Execute a local command in the Agent workspace directory and return exit code, stdout, and stderr. Pass the executable as command and each argument separately in args. This does not run through a shell unless command is explicitly a shell such as cmd, powershell, or sh.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": { "type": "string", "description": "Executable to run, e.g. npm, cargo, python, git, cmd, powershell, or sh." },
                            "args": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "Command arguments as separate strings. Defaults to []."
                            },
                            "timeout_seconds": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": MAX_COMMAND_TIMEOUT_SECONDS,
                                "description": "Optional timeout in seconds. Defaults to 30. For long builds such as EDK2/BaseTools, use 1800-7200."
                            }
                        },
                        "required": ["command"],
                        "additionalProperties": false
                    }
                }
            })),
            _ => {
                eprintln!("WARNING：找不到工具「{name}」，已略過並繼續執行");
                Ok(Value::Null)
            }
        })
        .collect();
    Ok(defs?.into_iter().filter(|v| !v.is_null()).collect())
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
    let canonical = path.canonicalize().map_err(|error| {
        format!("路徑不存在或無法存取：{error}\nnext_step: 請先用 list_directory 探索工作目錄結構，確認正確路徑後再重試。")
    })?;
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

fn is_dot_prefixed_dir(path: &Path, metadata: &fs::Metadata) -> bool {
    metadata.is_dir()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with('.'))
            .unwrap_or(false)
}

fn required_string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少字串參數 {name}"))
}

fn optional_string_array(arguments: &Value, name: &str) -> Result<Vec<String>, String> {
    match arguments.get(name) {
        None => Ok(vec![]),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("{name} 必須是字串陣列"))
            })
            .collect(),
        Some(_) => Err(format!("{name} 必須是字串陣列")),
    }
}

fn parse_json_string_array(raw: &str) -> Result<Vec<String>, String> {
    let wrapped = format!("[{raw}]");
    let values: Vec<Value> = serde_json::from_str(&wrapped).map_err(|e| e.to_string())?;
    values
        .into_iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "args must contain strings only".to_string())
        })
        .collect()
}

fn parse_execute_command_arguments_fallback(raw: &str) -> Option<Value> {
    let command_marker = "\"command\"";
    let command_marker_idx = raw.find(command_marker)?;
    let command_colon_idx = raw[command_marker_idx + command_marker.len()..].find(':')?
        + command_marker_idx
        + command_marker.len();
    let command_raw = raw[command_colon_idx + 1..].trim_start();
    let decoder = serde_json::Deserializer::from_str(command_raw);
    let mut stream = decoder.into_iter::<String>();
    let command = stream.next()?.ok()?;

    let args_marker = "\"args\"";
    let args_marker_idx = raw.find(args_marker)?;
    let args_open_rel = raw[args_marker_idx..].find('[')?;
    let args_start = args_marker_idx + args_open_rel + 1;
    let timeout_marker = "\"timeout_seconds\"";
    let timeout_idx = raw.find(timeout_marker);
    let args_end = timeout_idx
        .and_then(|idx| raw[..idx].rfind(','))
        .or_else(|| raw[args_start..].find(']').map(|idx| args_start + idx))?;
    let args_raw = raw[args_start..args_end].trim().trim_end_matches(',');
    let args = parse_json_string_array(args_raw).ok()?;

    let mut out = serde_json::json!({
        "command": command,
        "args": args,
    });
    if let Some(idx) = timeout_idx {
        let timeout_colon_idx =
            raw[idx + timeout_marker.len()..].find(':')? + idx + timeout_marker.len();
        let timeout_tail = raw[timeout_colon_idx + 1..].trim_start();
        let digits: String = timeout_tail
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect();
        if let Ok(timeout) = digits.parse::<u64>() {
            out["timeout_seconds"] = serde_json::json!(timeout);
        }
    }
    Some(out)
}

fn parse_tool_arguments(name: &str, raw: &str) -> Result<Value, String> {
    match serde_json::from_str::<Value>(raw) {
        Ok(value) => Ok(value),
        Err(error) if name == "execute_command" => parse_execute_command_arguments_fallback(raw)
            .ok_or_else(|| format!("工具 {name} 的參數不是有效 JSON：{error}")),
        Err(error) => Err(format!("工具 {name} 的參數不是有效 JSON：{error}")),
    }
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn truncate_tool_output(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{truncated}\n\n…（輸出已截斷）")
}

fn perform_execute_command(root: &Path, arguments: &Value) -> Result<String, String> {
    let command = required_string(arguments, "command")?.trim();
    if command.is_empty() {
        return Err("execute_command 的 command 不可為空".to_string());
    }
    let args = optional_string_array(arguments, "args")?;
    let timeout_seconds = arguments
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECONDS)
        .clamp(1, MAX_COMMAND_TIMEOUT_SECONDS);
    let timeout = std::time::Duration::from_secs(timeout_seconds);
    let started = std::time::Instant::now();

    let mut child = std::process::Command::new(command)
        .args(&args)
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("無法啟動 command：{error}"))?;

    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                let _ = child.kill();
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(error) => return Err(format!("等待 command 失敗：{error}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("讀取 command 輸出失敗：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(serde_json::json!({
        "command": command,
        "args": args,
        "cwd": root.to_string_lossy(),
        "success": output.status.success() && !timed_out,
        "exit_code": output.status.code(),
        "timed_out": timed_out,
        "timeout_seconds": timeout_seconds,
        "stdout": truncate_tool_output(&stdout, 12000),
        "stderr": truncate_tool_output(&stderr, 12000)
    })
    .to_string())
}

async fn read_command_stream(
    stream_name: &'static str,
    reader: impl tokio::io::AsyncRead + Unpin,
    tx: tokio::sync::mpsc::UnboundedSender<(&'static str, String)>,
) {
    let mut reader = tokio::io::BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf)
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                let _ = tx.send((stream_name, line));
            }
            Err(error) => {
                let _ = tx.send((stream_name, format!("讀取輸出失敗：{error}")));
                break;
            }
        }
    }
}

fn emit_command_output_batch(
    app_handle: &tauri::AppHandle,
    item_id: u32,
    round: usize,
    endpoint: &str,
    call_id: &str,
    command: &str,
    args: &[String],
    cwd: &str,
    lines: &[(String, String)],
) {
    if lines.is_empty() {
        return;
    }
    let payload_lines: Vec<Value> = lines
        .iter()
        .map(|(stream, line)| serde_json::json!({ "stream": stream, "line": line }))
        .collect();
    let (stream, line) = lines
        .last()
        .map(|(stream, line)| (stream.as_str(), line.as_str()))
        .unwrap_or(("stdout", ""));
    emit_model_exchange_for_item(
        app_handle,
        item_id,
        round,
        "command_output",
        endpoint,
        serde_json::json!({
            "callId": call_id,
            "name": "execute_command",
            "command": command,
            "args": args,
            "cwd": cwd,
            "stream": stream,
            "line": line,
            "lines": payload_lines,
        }),
    );
}

fn looks_like_completion_command(command: &str, args: &[String]) -> bool {
    let command_lower = command.to_ascii_lowercase();
    let script = format!("{} {}", command_lower, args.join(" ").to_ascii_lowercase());
    let command_name = Path::new(command)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
        .to_ascii_lowercase();

    command_name == "build"
        || script.contains("build.bat")
        || script.contains("\\build ")
        || script.contains("/build ")
        || script.contains(" nmake")
        || script.contains(" ninja")
        || script.contains(" msbuild")
        || script.contains(" cargo build")
        || script.contains(" cargo test")
        || script.contains(" npm run build")
        || script.contains(" npm test")
        || script.contains(" pytest")
        || script.contains(" ctest")
}

fn execute_command_next_step(
    success: bool,
    timed_out: bool,
    command: &str,
    args: &[String],
) -> String {
    if timed_out {
        return "The command timed out. Diagnose the timeout, then either retry with a clearer command or report the blocker.".to_string();
    }
    if !success {
        return "The command failed. Use the exit code, stdout, and stderr from this result to fix the issue before retrying.".to_string();
    }
    if looks_like_completion_command(command, args) {
        return "This build/test command completed successfully. If this satisfies the user's request, stop calling more tools and provide the final concise result now.".to_string();
    }
    "The command completed successfully. If it answered the user's request, stop calling more tools and summarize the result.".to_string()
}

async fn perform_execute_command_streaming(
    app_handle: &tauri::AppHandle,
    request: &AgentExecutionRequest,
    round: usize,
    endpoint: &str,
    root: &Path,
    call_id: &str,
    arguments: &Value,
) -> Result<String, String> {
    let command = required_string(arguments, "command")?.trim();
    if command.is_empty() {
        return Err("execute_command 的 command 不可為空".to_string());
    }
    let args = optional_string_array(arguments, "args")?;
    let timeout_seconds = arguments
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECONDS)
        .clamp(1, MAX_COMMAND_TIMEOUT_SECONDS);
    let timeout = std::time::Duration::from_secs(timeout_seconds);
    let started = std::time::Instant::now();

    let mut child = tokio::process::Command::new(command)
        .args(&args)
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("無法啟動 command：{error}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(&'static str, String)>();
    let stdout_task = child.stdout.take().map(|stdout| {
        let tx = tx.clone();
        tokio::spawn(read_command_stream("stdout", stdout, tx))
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        let tx = tx.clone();
        tokio::spawn(read_command_stream("stderr", stderr, tx))
    });
    drop(tx);

    let mut stdout_text = String::new();
    let mut stderr_text = String::new();
    let mut timed_out = false;
    let cwd = root.to_string_lossy().to_string();
    let mut pending_output: Vec<(String, String)> = Vec::new();

    let mut queue_line = |stream: &str, line: &str, pending: &mut Vec<(String, String)>| {
        if stream == "stderr" {
            stderr_text.push_str(line);
            stderr_text.push('\n');
        } else {
            stdout_text.push_str(line);
            stdout_text.push('\n');
        }
        pending.push((stream.to_string(), line.to_string()));
    };

    queue_line(
        "system",
        &format!("$ {} {}", command, args.join(" ")).trim_end(),
        &mut pending_output,
    );
    emit_command_output_batch(
        app_handle,
        request.item_id,
        round,
        endpoint,
        call_id,
        command,
        &args,
        &cwd,
        &pending_output,
    );
    pending_output.clear();
    let mut last_flush = std::time::Instant::now();

    let status = loop {
        while let Ok((stream, line)) = rx.try_recv() {
            queue_line(stream, &line, &mut pending_output);
        }
        if pending_output.len() >= 50
            || last_flush.elapsed() >= std::time::Duration::from_millis(250)
        {
            emit_command_output_batch(
                app_handle,
                request.item_id,
                round,
                endpoint,
                call_id,
                command,
                &args,
                &cwd,
                &pending_output,
            );
            pending_output.clear();
            last_flush = std::time::Instant::now();
        }
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                break Some(exit_status);
            }
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                let _ = child.kill().await;
                break child.wait().await.ok();
            }
            Ok(None) => {}
            Err(error) => return Err(format!("等待 command 失敗：{error}")),
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };

    async fn drain_reader_task(mut task: tokio::task::JoinHandle<()>) {
        if tokio::time::timeout(std::time::Duration::from_millis(250), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }

    if let Some(task) = stdout_task {
        drain_reader_task(task).await;
    }
    if let Some(task) = stderr_task {
        drain_reader_task(task).await;
    }
    while let Ok((stream, line)) = rx.try_recv() {
        queue_line(stream, &line, &mut pending_output);
    }

    let success = status.map(|s| s.success()).unwrap_or(false) && !timed_out;
    let exit_code = status.and_then(|s| s.code());
    let final_line = if timed_out {
        format!("Command timed out after {timeout_seconds}s")
    } else {
        format!(
            "Command exited with code {}",
            exit_code.map_or_else(|| "unknown".to_string(), |c| c.to_string())
        )
    };
    queue_line("system", &final_line, &mut pending_output);
    emit_command_output_batch(
        app_handle,
        request.item_id,
        round,
        endpoint,
        call_id,
        command,
        &args,
        &cwd,
        &pending_output,
    );
    let next_step = execute_command_next_step(success, timed_out, command, &args);

    Ok(serde_json::json!({
        "command": command,
        "args": args,
        "cwd": cwd,
        "success": success,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "timeout_seconds": timeout_seconds,
        "next_step": next_step,
        "stdout": truncate_tool_output(&stdout_text, 12000),
        "stderr": truncate_tool_output(&stderr_text, 12000)
    })
    .to_string())
}

struct SearchContentState {
    files_scanned: usize,
    truncated: bool,
    started_at: std::time::Instant,
}

impl SearchContentState {
    fn new() -> Self {
        Self {
            files_scanned: 0,
            truncated: false,
            started_at: std::time::Instant::now(),
        }
    }

    fn should_stop(&mut self, matches: &[Value]) -> bool {
        if matches.len() >= MAX_SEARCH_RESULTS
            || self.files_scanned >= MAX_SEARCH_FILES
            || self.started_at.elapsed() >= std::time::Duration::from_millis(MAX_SEARCH_DURATION_MS)
        {
            self.truncated = matches.len() >= MAX_SEARCH_RESULTS
                || self.files_scanned >= MAX_SEARCH_FILES
                || self.started_at.elapsed()
                    >= std::time::Duration::from_millis(MAX_SEARCH_DURATION_MS);
            return true;
        }
        false
    }
}

fn search_file_content(
    root: &Path,
    path: &Path,
    query: &str,
    case_sensitive: bool,
    matches: &mut Vec<Value>,
    state: &mut SearchContentState,
) {
    if state.should_stop(matches) {
        return;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.is_dir() {
        if path != root && is_dot_prefixed_dir(path, &metadata) {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            if state.should_stop(matches) {
                break;
            }
            let Ok(canonical) = entry.path().canonicalize() else {
                continue;
            };
            if canonical.starts_with(root) {
                search_file_content(root, &canonical, query, case_sensitive, matches, state);
            }
        }
        return;
    }
    if !metadata.is_file() || metadata.len() > MAX_TOOL_FILE_SIZE {
        return;
    }
    state.files_scanned += 1;
    if state.should_stop(matches) {
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
            if state.should_stop(matches) {
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
        "list_directory" | "list_dir" => {
            let path = resolve_existing_tool_path(
                root,
                arguments.get("path").and_then(Value::as_str).unwrap_or("."),
            )?;
            if !path.is_dir() {
                return Err(format!("{name} 的 path 不是目錄"));
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
                if is_dot_prefixed_dir(&canonical, &metadata) {
                    continue;
                }
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
            let mut state = SearchContentState::new();
            search_file_content(
                root,
                &path,
                query,
                arguments
                    .get("case_sensitive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                &mut matches,
                &mut state,
            );
            let result = serde_json::json!({
                "matches": matches,
                "files_scanned": state.files_scanned,
                "truncated": state.truncated,
                "warning": if state.truncated {
                    Some(format!("search_content stopped after scanning {} files, {}ms, or {} matches. This tool searches file contents, not filenames. For known scripts such as build.bat, call execute_command directly.", MAX_SEARCH_FILES, MAX_SEARCH_DURATION_MS, MAX_SEARCH_RESULTS))
                } else {
                    None
                }
            });
            serde_json::to_string(&result).map_err(|error| error.to_string())
        }
        "grep_search" => {
            let query = required_string(arguments, "query")?;
            if query.is_empty() {
                return Err("grep_search 的 query 不可為空".to_string());
            }
            let path = resolve_existing_tool_path(
                root,
                arguments.get("path").and_then(Value::as_str).unwrap_or("."),
            )?;
            let mut matches = Vec::new();
            let mut state = SearchContentState::new();
            search_file_content(
                root,
                &path,
                query,
                arguments
                    .get("case_sensitive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                &mut matches,
                &mut state,
            );
            let result = serde_json::json!({
                "matches": matches,
                "files_scanned": state.files_scanned,
                "truncated": state.truncated,
                "warning": if state.truncated {
                    Some(format!("grep_search stopped after scanning {} files, {}ms, or {} matches.", MAX_SEARCH_FILES, MAX_SEARCH_DURATION_MS, MAX_SEARCH_RESULTS))
                } else {
                    None
                }
            });
            serde_json::to_string(&result).map_err(|error| error.to_string())
        }
        "read_file" => {
            let path = resolve_existing_tool_path(root, required_string(arguments, "path")?)?;
            let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
            if !metadata.is_file() || metadata.len() > MAX_TOOL_FILE_SIZE {
                return Err("read_file 僅支援 1 MB 以下的文字檔".to_string());
            }
            let content = fs::read_to_string(&path)
                .map_err(|error| format!("無法讀取 UTF-8 文字檔：{error}"))?;

            let offset_given = arguments.get("offset").and_then(Value::as_u64);
            let limit_given = arguments.get("limit").and_then(Value::as_u64);
            let offset = offset_given.unwrap_or(1).max(1) as usize;
            let limit = limit_given.unwrap_or(READ_FILE_DEFAULT_LIMIT as u64) as usize;

            let lines: Vec<&str> = content.lines().collect();
            let total_lines = lines.len();

            // 未指定 offset/limit 且檔案本身不長：直接回傳全文，維持簡單案例的行為不變
            if offset_given.is_none() && limit_given.is_none() && total_lines <= READ_FILE_DEFAULT_LIMIT {
                return Ok(content);
            }

            let start = (offset - 1).min(total_lines);
            let end = start.saturating_add(limit).min(total_lines);
            let mut result = lines[start..end].join("\n");
            if start >= total_lines {
                result = format!("[檔案共 {total_lines} 行，offset {offset} 已超出範圍]");
            } else if end < total_lines {
                result.push_str(&format!(
                    "\n\n[已截斷：顯示第 {}-{} 行，檔案共 {} 行。如需其餘內容，請帶 offset/limit 參數再次呼叫 read_file。]",
                    start + 1,
                    end,
                    total_lines
                ));
            }
            Ok(result)
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
            let message = arguments
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("");
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
                let _ = handle.emit(
                    "agent-event-triggered",
                    AgentEventPayload {
                        event_id: event_id.to_string(),
                        message: message.to_string(),
                        arg1: arg1.to_string(),
                        arg2: arg2.to_string(),
                        arg3: arg3.to_string(),
                    },
                );
            }
            Ok(format!("已觸發事件：事件 ID 為「{}」，訊息為「{}」，arg1為「{}」，arg2為「{}」，arg3為「{}」", event_id, message, arg1, arg2, arg3))
        }
        "get_current_time" => {
            let tz_arg = arguments
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let utc_now = chrono::Utc::now();
            let (formatted, tz_label, is_default) = if tz_arg.is_empty() {
                let system_tz_name = iana_time_zone::get_timezone().ok();
                match system_tz_name
                    .as_deref()
                    .and_then(|n| n.parse::<chrono_tz::Tz>().ok())
                {
                    Some(tz) => {
                        let converted = utc_now.with_timezone(&tz);
                        (
                            converted.format("%Y-%m-%d %H:%M:%S %z").to_string(),
                            system_tz_name.unwrap(),
                            true,
                        )
                    }
                    None => {
                        let local = chrono::Local::now();
                        (
                            local.format("%Y-%m-%d %H:%M:%S %z").to_string(),
                            format!("system local ({})", local.offset()),
                            true,
                        )
                    }
                }
            } else {
                let tz: chrono_tz::Tz = tz_arg.parse().map_err(|_| {
                    format!("無效的時區：{tz_arg}（請用 IANA 名稱，如 Asia/Taipei）")
                })?;
                let converted = utc_now.with_timezone(&tz);
                (
                    converted.format("%Y-%m-%d %H:%M:%S %z").to_string(),
                    tz_arg.to_string(),
                    false,
                )
            };
            Ok(serde_json::json!({
                "iso_utc": utc_now.to_rfc3339(),
                "formatted": formatted,
                "timezone": tz_label,
                "source": if is_default { "system default" } else { "user-specified" },
                "unix_ms": utc_now.timestamp_millis()
            })
            .to_string())
        }
        "execute_command" => perform_execute_command(root, arguments),
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
            McpClientState::Stdio {
                stdin,
                reader,
                request_id,
                ..
            } => {
                *request_id += 1;
                let id = *request_id;
                let req =
                    serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
                let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
                line.push('\n');
                stdin
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())?;
                loop {
                    let mut resp = String::new();
                    reader
                        .read_line(&mut resp)
                        .await
                        .map_err(|e| e.to_string())?;
                    if resp.is_empty() {
                        return Err("MCP server 已關閉".to_string());
                    }
                    let v: Value = serde_json::from_str(resp.trim()).map_err(|e| e.to_string())?;
                    if v.get("id").map(|x| !x.is_null()).unwrap_or(false) {
                        if let Some(err) = v.get("error") {
                            return Err(format!("MCP 錯誤：{err}"));
                        }
                        return Ok(v["result"].clone());
                    }
                }
            }
            McpClientState::Http {
                client,
                url,
                request_id,
            } => {
                *request_id += 1;
                let id = *request_id;
                let req =
                    serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
                let v: Value = client
                    .post(url.as_str())
                    .json(&req)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?
                    .json()
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(err) = v.get("error") {
                    return Err(format!("MCP 錯誤：{err}"));
                }
                Ok(v["result"].clone())
            }
        }
    }

    async fn list_tools(&mut self) -> Result<Vec<Value>, String> {
        let result = self
            .send_json_rpc("tools/list", serde_json::json!({}))
            .await?;
        Ok(result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    async fn call_tool(&mut self, name: &str, args: &Value) -> Result<String, String> {
        let result = self
            .send_json_rpc(
                "tools/call",
                serde_json::json!({"name": name, "arguments": args}),
            )
            .await?;
        if let Some(content) = result.get("content").and_then(Value::as_array) {
            let text = content
                .iter()
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

async fn init_mcp_client(
    config: &McpServerConfig,
    working_dir: &str,
) -> Result<McpClientState, String> {
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

    client
        .send_json_rpc(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "ListAgent", "version": "0.1.0"}
            }),
        )
        .await?;

    // notifications/initialized (required by some stdio servers)
    if let McpClientState::Stdio { stdin, .. } = &mut client {
        let notif =
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\",\"params\":{}}\n";
        stdin
            .write_all(notif.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
    }

    Ok(client)
}

fn mcp_tools_to_openai(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|t| {
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
        })
        .collect()
}

#[tauri::command]
async fn list_mcp_server_tools(
    server: McpServerConfig,
    working_directory: String,
) -> Result<Vec<McpToolInfo>, String> {
    let mut client = init_mcp_client(&server, &working_directory).await?;
    let tools = client.list_tools().await?;
    Ok(tools
        .iter()
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?.to_string();
            let description = t
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Some(McpToolInfo { name, description })
        })
        .collect())
}

fn load_memory_messages(working_directory: &str, item_code: &str) -> Vec<Value> {
    let dir = session_base_dir(working_directory, item_code);
    if !dir.exists() {
        return vec![];
    }

    // When workspace is set, sessions from all items pool together — filter by itemId.
    let filter_item_id = if !working_directory.trim().is_empty() {
        parse_item_code(item_code)
    } else {
        None
    };

    let mut sessions: Vec<(u64, PathBuf)> = match fs::read_dir(&dir) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    return None;
                }
                if !entry.file_name().to_string_lossy().starts_with("session_") {
                    return None;
                }
                if let Some(target_id) = filter_item_id {
                    match read_session_item_id(&path) {
                        Some(id) if id == target_id => {}
                        _ => return None,
                    }
                }
                let modified = entry
                    .metadata()
                    .ok()?
                    .modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()?
                    .as_millis() as u64;
                Some((modified, path))
            })
            .collect(),
        Err(_) => return vec![],
    };
    if sessions.is_empty() {
        return vec![];
    }
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
    let user_input = exchanges
        .iter()
        .find(|ex| {
            ex.get("phase").and_then(Value::as_str) == Some("request")
                && ex.get("round").and_then(Value::as_u64) == Some(1)
        })
        .and_then(|ex| ex.pointer("/payload/messages"))
        .and_then(Value::as_array)
        .and_then(|msgs| {
            msgs.iter()
                .find(|msg| msg.get("_source").and_then(Value::as_str) == Some("📨 使用者輸入"))
        })
        .and_then(|msg| msg.get("content").and_then(Value::as_str))
        .map(str::to_string);

    // Extract final assistant text response (last response exchange with non-empty content)
    let final_response = exchanges
        .iter()
        .rev()
        .find(|ex| {
            ex.get("phase").and_then(Value::as_str) == Some("response")
                && ex
                    .pointer("/payload/body/choices/0/message/content")
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

fn clean_assistant_content(content: &str) -> String {
    let mut s = content.to_string();
    while let Some(start_idx) = s.find("<|channel>thought") {
        if let Some(end_offset) = s[start_idx..].find("<channel|>") {
            let end_idx = start_idx + end_offset + "<channel|>".len();
            s.replace_range(start_idx..end_idx, "");
        } else if let Some(end_offset) = s[start_idx..].find("<|channel|>") {
            let end_idx = start_idx + end_offset + "<|channel|>".len();
            s.replace_range(start_idx..end_idx, "");
        } else {
            s.replace_range(start_idx.., "");
            break;
        }
    }
    while let Some(start_idx) = s.find("<|channel>") {
        if let Some(end_offset) = s[start_idx..].find("<channel|>") {
            let end_idx = start_idx + end_offset + "<channel|>".len();
            s.replace_range(start_idx..end_idx, "");
        } else if let Some(end_offset) = s[start_idx..].find("<|channel|>") {
            let end_idx = start_idx + end_offset + "<|channel|>".len();
            s.replace_range(start_idx..end_idx, "");
        } else {
            s.replace_range(start_idx.., "");
            break;
        }
    }
    while let Some(start_idx) = s.find("<thought>") {
        if let Some(end_offset) = s[start_idx..].find("</thought>") {
            let end_idx = start_idx + end_offset + "</thought>".len();
            s.replace_range(start_idx..end_idx, "");
        } else {
            s.replace_range(start_idx.., "");
            break;
        }
    }
    s.trim().to_string()
}

fn strip_html_tags_and_decode(input: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for c in input.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(c);
        }
    }
    result = result
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");
    result.trim().to_string()
}

fn url_decode(input: &str) -> String {
    let mut chars = input.chars();
    let mut result = String::new();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(c1), Some(c2)) = (h1, h2) {
                if let Ok(val) = u8::from_str_radix(&format!("{}{}", c1, c2), 16) {
                    result.push(val as char);
                    continue;
                }
            }
            result.push('%');
            if let Some(c1) = h1 {
                result.push(c1);
            }
            if let Some(c2) = h2 {
                result.push(c2);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

fn percent_encode(input: &str) -> String {
    input
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                (b as char).to_string()
            } else {
                format!("%{:02X}", b)
            }
        })
        .collect()
}

async fn perform_web_search(query: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("無法建立 HTTP client: {e}"))?;

    let url = "https://html.duckduckgo.com/html/";
    let response = client
        .post(url)
        .form(&[("q", query)])
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .await;

    match response {
        Ok(res) if res.status().is_success() => {
            let html = res.text().await.unwrap_or_default();
            let mut results = Vec::new();

            let parts: Vec<&str> = html.split("class=\"result ").collect();
            for part in parts.into_iter().skip(1) {
                let mut url = String::new();
                if let Some(a_idx) = part.find("class=\"result__a\"") {
                    let sub = &part[a_idx..];
                    if let Some(href_idx) = sub.find("href=\"") {
                        let start = href_idx + 6;
                        if let Some(end) = sub[start..].find("\"") {
                            let raw_url = &sub[start..start + end];
                            if raw_url.contains("uddg=") {
                                if let Some(uddg_idx) = raw_url.find("uddg=") {
                                    let raw_redirect = &raw_url[uddg_idx + 5..];
                                    let decoded = url_decode(raw_redirect);
                                    url = if let Some(amp_idx) = decoded.find('&') {
                                        decoded[..amp_idx].to_string()
                                    } else {
                                        decoded
                                    };
                                } else {
                                    url = raw_url.to_string();
                                }
                            } else {
                                url = raw_url.to_string();
                            }
                        }
                    }
                }

                let mut title = String::new();
                if let Some(a_idx) = part.find("class=\"result__a\"") {
                    let sub = &part[a_idx..];
                    if let Some(tag_close) = sub.find('>') {
                        let start = tag_close + 1;
                        if let Some(a_close) = sub[start..].find("</a>") {
                            title = strip_html_tags_and_decode(&sub[start..start + a_close]);
                        }
                    }
                }

                let mut snippet = String::new();
                if let Some(snippet_idx) = part.find("class=\"result__snippet\"") {
                    let sub = &part[snippet_idx..];
                    if let Some(tag_close) = sub.find('>') {
                        let start = tag_close + 1;
                        if let Some(div_close) = sub[start..].find("</div>") {
                            snippet = strip_html_tags_and_decode(&sub[start..start + div_close]);
                        }
                    }
                }

                if !title.is_empty() && !url.is_empty() {
                    results.push(serde_json::json!({
                        "title": title,
                        "url": url,
                        "snippet": snippet
                    }));
                }

                if results.len() >= 8 {
                    break;
                }
            }

            if !results.is_empty() {
                return serde_json::to_string_pretty(&results).map_err(|e| e.to_string());
            }
        }
        _ => {}
    }

    let wiki_url = format!(
        "https://zh.wikipedia.org/w/api.php?action=opensearch&search={}&limit=8&namespace=0&format=json",
        percent_encode(query)
    );
    let wiki_res = client
        .get(&wiki_url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|e| format!("搜尋失敗且維基百科備用搜尋不可用: {e}"))?;

    let wiki_json: Value = wiki_res
        .json()
        .await
        .map_err(|e| format!("維基百科資料解析失敗: {e}"))?;

    if let Some(arr) = wiki_json.as_array() {
        if arr.len() >= 4 {
            let titles = arr[1].as_array().ok_or("無效的維基百科標題欄位")?;
            let snippets = arr[2].as_array().ok_or("無效的維基百科描述欄位")?;
            let urls = arr[3].as_array().ok_or("無效的維基百科連結欄位")?;

            let mut results = Vec::new();
            for i in 0..titles.len() {
                results.push(serde_json::json!({
                    "title": titles[i].as_str().unwrap_or("").to_string(),
                    "url": urls[i].as_str().unwrap_or("").to_string(),
                    "snippet": snippets[i].as_str().unwrap_or("").to_string(),
                }));
            }
            return serde_json::to_string_pretty(&results).map_err(|e| e.to_string());
        }
    }

    Err("搜尋未傳回任何結果".to_string())
}

async fn perform_fetch_url(url: &str) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("fetch_url 只支援 http/https URL".to_string());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("無法建立 HTTP client: {e}"))?;

    let response = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("fetch 失敗：{e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("fetch 回傳 HTTP {status}"));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let body = response
        .text()
        .await
        .map_err(|e| format!("讀取回應失敗：{e}"))?;

    let text =
        if content_type.contains("html") || content_type.contains("xml") || content_type.is_empty()
        {
            let mut cleaned = strip_html_block(&body, "script");
            cleaned = strip_html_block(&cleaned, "style");
            cleaned = strip_html_block(&cleaned, "noscript");
            let stripped = strip_html_tags_and_decode(&cleaned);
            collapse_whitespace(&stripped)
        } else {
            body
        };

    const MAX_LEN: usize = 8000;
    if text.chars().count() > MAX_LEN {
        let truncated: String = text.chars().take(MAX_LEN).collect();
        Ok(format!("{truncated}\n\n…（已截斷，原始內容較長）"))
    } else {
        Ok(text)
    }
}

fn strip_html_block(input: &str, tag: &str) -> String {
    let lower = input.to_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::new();
    let mut idx = 0;
    while let Some(rel_start) = lower[idx..].find(&open) {
        let start = idx + rel_start;
        out.push_str(&input[idx..start]);
        let after_open = start + open.len();
        let gt = match lower[after_open..].find('>') {
            Some(offset) => after_open + offset + 1,
            None => {
                idx = input.len();
                break;
            }
        };
        match lower[gt..].find(&close) {
            Some(offset) => {
                idx = gt + offset + close.len();
            }
            None => {
                idx = input.len();
                break;
            }
        }
    }
    if idx < input.len() {
        out.push_str(&input[idx..]);
    }
    out
}

fn collapse_whitespace(input: &str) -> String {
    let mut out = String::new();
    let mut last_was_space = false;
    let mut consecutive_newlines = 0;
    for c in input.chars() {
        if c == '\n' {
            consecutive_newlines += 1;
            if consecutive_newlines <= 2 {
                out.push('\n');
            }
            last_was_space = true;
        } else if c.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(c);
            last_was_space = false;
            consecutive_newlines = 0;
        }
    }
    out.trim().to_string()
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
    // Definitions for the tools the user pre-checked (goes straight into tools[] payload).
    let selected_builtin_defs = tool_definitions(&request.tools)?;
    let workspace_root = tool_workspace_root(&request.working_directory)?;

    // Connect to MCP servers and collect their tools
    let mut mcp_clients: Vec<(String, McpClientState)> = Vec::new();
    // tool_name -> index into mcp_clients
    let mut mcp_tool_map: HashMap<String, usize> = HashMap::new();
    let mut mcp_tool_definitions: Vec<Value> = Vec::new();
    let workspace_str = workspace_root.to_str().unwrap_or("");
    for server in &request.mcp_servers {
        if !server.enabled {
            continue;
        }
        match init_mcp_client(server, workspace_str).await {
            Ok(mut client) => {
                match client.list_tools().await {
                    Ok(tools) => {
                        let idx = mcp_clients.len();
                        let openai_tools_all = mcp_tools_to_openai(&tools);

                        let is_mcp_empty = request.selected_mcp_tools.is_empty();
                        let openai_tools: Vec<Value> = if is_mcp_empty {
                            openai_tools_all
                        } else {
                            openai_tools_all
                                .into_iter()
                                .filter(|t| {
                                    let name = t
                                        .pointer("/function/name")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    let qualified = format!("{}::{}", server.name, name);
                                    request.selected_mcp_tools.contains(&qualified)
                                })
                                .collect()
                        };
                        for t in &openai_tools {
                            if let Some(name) = t.pointer("/function/name").and_then(Value::as_str)
                            {
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
    // Build a catalog of every tool definition keyed by name.
    let mut all_tool_defs: std::collections::HashMap<String, Value> =
        std::collections::HashMap::new();
    for def in selected_builtin_defs
        .iter()
        .chain(mcp_tool_definitions.iter())
    {
        if let Some(name) = def.pointer("/function/name").and_then(Value::as_str) {
            all_tool_defs.insert(name.to_string(), def.clone());
        }
    }

    let skill_entries = load_skill_entries(&request.skills);
    let search_tool_def = serde_json::json!({
        "type": "function",
        "function": {
            "name": "search_tools_and_skills",
            "description": "Search for tools and skills relevant to what you're about to do, and unlock/load them into context. Tools and skills are NOT available until found this way — call this with a keyword describing the capability you need (e.g. a tool name, or a topic) before assuming something isn't available. Matched tools become callable next round; matched skills are injected as additional instructions immediately. Call again with a different keyword if you need something else.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keyword describing the capability you need, e.g. a tool name or a short topic phrase."
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }
    });
    // tools_search off: everything pre-selected is unlocked immediately (unchanged behavior).
    // tools_search on: nothing is unlocked until the AI searches for it via search_tools_and_skills.
    let mut unlocked_tools: std::collections::HashSet<String> = if request.tools_search {
        std::collections::HashSet::new()
    } else {
        all_tool_defs.keys().cloned().collect()
    };
    let mut unlocked_skill_ids: std::collections::HashSet<String> = if request.tools_search {
        std::collections::HashSet::new()
    } else {
        skill_entries.iter().map(|(meta, _)| meta.id.clone()).collect()
    };
    let has_user_prompt = has_parameters && !request.prompt.trim().is_empty();
    // Skills injected into the initial system messages (only the ones unlocked at start).
    let skill_prompts: Vec<(String, String)> = skill_entries
        .iter()
        .filter(|(meta, _)| unlocked_skill_ids.contains(&meta.id))
        .map(|(meta, prompt)| (meta.name.clone(), prompt.clone()))
        .collect();
    let tools_search_hint = if request.tools_search {
        let mut lines = Vec::new();
        let mut tool_names: Vec<&String> = all_tool_defs.keys().collect();
        tool_names.sort();
        for name in tool_names {
            let desc = all_tool_defs[name]
                .pointer("/function/description")
                .and_then(Value::as_str)
                .unwrap_or("");
            let aliases = builtin_tool_aliases(name);
            if aliases.is_empty() {
                lines.push(format!("- [tool] {name}: {desc}"));
            } else {
                lines.push(format!("- [tool] {name}: {desc} (keywords: {})", aliases.join(", ")));
            }
        }
        for (meta, _) in &skill_entries {
            lines.push(format!("- [skill] {}: {}", meta.name, meta.description));
        }
        if lines.is_empty() {
            String::new()
        } else {
            format!(
                "\n\nSKILLS/TOOLS SEARCH is on: none of the following are loaded yet. Call search_tools_and_skills with a keyword (any single word from the name, description, or the keywords list below is enough — no need for an exact phrase) to unlock what you actually need before using it:\n{}",
                lines.join("\n")
            )
        }
    } else {
        String::new()
    };
    let memory_history = if request.memory && !request.item_code.is_empty() {
        load_memory_messages(&request.working_directory, &request.item_code)
    } else {
        vec![]
    };
    let mut messages = if let Some(resumed) = request.resume_messages.clone() {
        resumed
    } else {
        Vec::new()
    };
    if request.resume_messages.is_none() {
        if has_user_prompt {
            messages.push(serde_json::json!({ "role": "system", "content": request.prompt }));
        }
        for (_, skill_content) in &skill_prompts {
            messages.push(serde_json::json!({ "role": "system", "content": skill_content }));
        }
        let now_line = {
            let utc_now = chrono::Utc::now();
            let system_tz_name = iana_time_zone::get_timezone().ok();
            let (formatted, tz_label) = match system_tz_name
                .as_deref()
                .and_then(|n| n.parse::<chrono_tz::Tz>().ok())
            {
                Some(tz) => (
                    utc_now
                        .with_timezone(&tz)
                        .format("%Y-%m-%d %H:%M:%S %z")
                        .to_string(),
                    system_tz_name.unwrap(),
                ),
                None => {
                    let local = chrono::Local::now();
                    (
                        local.format("%Y-%m-%d %H:%M:%S %z").to_string(),
                        format!("system local ({})", local.offset()),
                    )
                }
            };
            format!("Now: {formatted} ({tz_label}).")
        };
        let workspace_line = format!(
            "Workspace: {}. Use relative paths or absolute paths under it only.",
            workspace_root.display()
        );
        let builtin_instruction = system_prompt_config()
            .builtin_agent_instruction
            .replace("{now_line}", &now_line)
            .replace("{workspace_line}", &workspace_line);
        messages.push(serde_json::json!({
            "role": "system",
            "content": format!("{builtin_instruction}{tools_search_hint}")
        }));
        messages.extend(memory_history.iter().cloned());
        messages.push(serde_json::json!({ "role": "user", "content": input }));
    }

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
    let max_iterations = request.max_rounds as usize;
    let mut round_index = request.resume_round.unwrap_or(0) as usize;
    while round_index < max_iterations {
        let round = round_index + 1;
        let tool_choice = if execution_logs.is_empty() && tool_choice_required && round == 1 {
            "required"
        } else {
            "auto"
        };
        // Check for any pending user messages to inject
        let mut inserted_msgs = Vec::new();
        if let Ok(mut map) = pending_agent_messages().lock() {
            if let Some(msgs) = map.get_mut(&request.item_id) {
                if !msgs.is_empty() {
                    inserted_msgs = msgs.drain(..).collect::<Vec<_>>();
                }
            }
        }
        if !inserted_msgs.is_empty() {
            for msg in inserted_msgs {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": msg
                }));
                emit_model_exchange(
                    app_handle,
                    request,
                    round,
                    "user_input",
                    &endpoint,
                    serde_json::json!({ "content": msg }),
                );
            }
        }

        let active_tools: Vec<Value> = if request.tools_search {
            let mut tools = vec![search_tool_def.clone()];
            tools.extend(
                unlocked_tools
                    .iter()
                    .filter_map(|name| all_tool_defs.get(name).cloned()),
            );
            tools
        } else {
            all_tool_defs.values().cloned().collect()
        };
        let mut body = serde_json::json!({
            "model": request.model_name,
            "messages": messages.clone(),
            "tools": active_tools,
            "tool_choice": tool_choice,
            "parallel_tool_calls": false,
            "stream": false
        });
        if base_url.ends_with("/api/v1") || base_url.ends_with("/api/v1/chat") {
            // Gemma 4 reasoning markers can be misread by LM Studio's tool parser.
            body["reasoning"] = Value::String("off".to_string());
        }
        // Build annotated copy for logging (actual request uses body without _source)
        let mut emit_body = body.clone();
        if let Some(msgs) = emit_body["messages"].as_array_mut() {
            if request.resume_messages.is_some() {
                annotate_resumed_message_sources(msgs);
            } else {
            // Layout: [user_prompt?] [skill_0..n?] [agent_instruction] [memory_0..n?] [user_input] [history...]
            let skill_count = skill_prompts.len();
            let agent_instr_idx = (has_user_prompt as usize) + skill_count;
            let memory_count = memory_history.len();
            let user_input_idx = agent_instr_idx + 1 + memory_count;
            for (i, msg) in msgs.iter_mut().enumerate() {
                let source = if has_user_prompt && i == 0 {
                    "📝 項目 Prompt".to_string()
                } else if i >= (has_user_prompt as usize)
                    && i < (has_user_prompt as usize) + skill_count
                {
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
        }
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
                // For network errors, surface the request context so the user can debug.
                emit_model_exchange(app_handle, request, round, "request", &endpoint, emit_body);
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

        // Detect the silent-retry case BEFORE emitting anything — thinking models
        // (e.g. DeepSeek) reject tool_choice="required" with a 400. We fall back
        // to "auto" transparently and don't want the failed round in the log.
        if !status.is_success()
            && status.as_u16() == 400
            && tool_choice_required
            && execution_logs.is_empty()
            && response_body.contains("tool_choice")
        {
            tool_choice_required = false;
            continue; // round_index NOT incremented → retries same round, no emit
        }

        let response_payload = serde_json::from_str(&response_body)
            .unwrap_or_else(|_| serde_json::json!({ "raw": response_body.clone() }));
        emit_model_exchange(app_handle, request, round, "request", &endpoint, emit_body);
        emit_model_exchange(
            app_handle,
            request,
            round,
            "response",
            &endpoint,
            serde_json::json!({ "status": status.as_u16(), "body": response_payload }),
        );
        if !status.is_success() {
            return Err(format!("模型 API 回傳 {status}：{response_body}"));
        }
        let json: Value = serde_json::from_str(&response_body)
            .map_err(|error| format!("模型回應不是有效 JSON：{error}；內容：{response_body}"))?;
        let latest_stats = json.get("usage").cloned();
        let mut message = json
            .pointer("/choices/0/message")
            .cloned()
            .ok_or_else(|| format!("模型回應缺少 choices[0].message：{response_body}"))?;

        if let Some(content_val) = message.get_mut("content") {
            if let Some(content_str) = content_val.as_str() {
                let cleaned = clean_assistant_content(content_str);
                *content_val = Value::String(cleaned);
            }
        }
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if tool_calls.is_empty() {
            let has_pending = if let Ok(map) = pending_agent_messages().lock() {
                map.get(&request.item_id)
                    .map(|msgs| !msgs.is_empty())
                    .unwrap_or(false)
            } else {
                false
            };
            if !has_pending {
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
                    paused: false,
                    resume_state: None,
                    actual_model: json.get("model").and_then(Value::as_str).map(str::to_string),
                });
            } else {
                println!(">>> execute_agent_with_tools: tool_calls is empty, but pending user messages exist! Continuing conversation loop.");
            }
        }

        messages.push(message);
        let mut skills_to_inject: Vec<(String, String)> = Vec::new();
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
            let parsed_arguments = parse_tool_arguments(name, raw_arguments);
            let arguments = parsed_arguments
                .clone()
                .unwrap_or_else(|_| serde_json::json!({}));
            let result = if let Err(error) = parsed_arguments {
                format!("Error: {error}. 請用有效 JSON 重新呼叫工具，並把 timeout_seconds 放在 args 陣列外層。")
            } else if request.tools_search && name == "search_tools_and_skills" {
                let query = arguments
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_lowercase();
                if query.is_empty() {
                    "Error: search_tools_and_skills 的 query 不可為空，請提供關鍵字（例如工具名稱或想達成的功能）。".to_string()
                } else {
                    // Multi-word queries ("execute command", "git commit") must match on ANY
                    // meaningful token, not the whole phrase — otherwise almost nothing matches.
                    let tokens: Vec<String> = query
                        .split(|c: char| !c.is_alphanumeric())
                        .filter(|s| s.len() >= 2)
                        .map(|s| s.to_string())
                        .collect();
                    let matches_text = |haystack: &str| -> bool {
                        haystack.contains(&query) || tokens.iter().any(|t| haystack.contains(t.as_str()))
                    };
                    let mut matched_tools: Vec<String> = Vec::new();
                    let mut tool_names: Vec<&String> = all_tool_defs.keys().collect();
                    tool_names.sort();
                    for tool_name in tool_names {
                        let def = &all_tool_defs[tool_name];
                        let desc = def
                            .pointer("/function/description")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let aliases = builtin_tool_aliases(tool_name).join(" ");
                        let haystack = format!("{tool_name} {desc} {aliases}").to_lowercase();
                        if matches_text(&haystack) {
                            matched_tools.push(format!("{tool_name}: {desc}"));
                            unlocked_tools.insert(tool_name.clone());
                        }
                    }
                    let mut matched_skills: Vec<String> = Vec::new();
                    for (meta, prompt) in &skill_entries {
                        let haystack = format!("{} {} {}", meta.id, meta.name, meta.description).to_lowercase();
                        if matches_text(&haystack) {
                            matched_skills.push(format!("{}: {}", meta.name, meta.description));
                            if unlocked_skill_ids.insert(meta.id.clone()) {
                                skills_to_inject.push((meta.name.clone(), prompt.clone()));
                            }
                        }
                    }
                    if matched_tools.is_empty() && matched_skills.is_empty() {
                        let mut all_names: Vec<&String> = all_tool_defs.keys().collect();
                        all_names.sort();
                        let skill_names: Vec<&str> =
                            skill_entries.iter().map(|(m, _)| m.name.as_str()).collect();
                        format!(
                            "找不到符合關鍵字「{query}」的工具或 skill。可用工具名稱：{}；可用 Skills：{}。請直接用上述其中一個確切名稱再搜尋一次。",
                            all_names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "),
                            if skill_names.is_empty() { "（無）".to_string() } else { skill_names.join(", ") }
                        )
                    } else {
                        let mut parts = Vec::new();
                        if !matched_tools.is_empty() {
                            parts.push(format!("符合的工具（已解鎖，下一輪可直接呼叫）：\n{}", matched_tools.join("\n")));
                        }
                        if !matched_skills.is_empty() {
                            parts.push(format!("符合的 Skills（已載入為額外指示）：\n{}", matched_skills.join("\n")));
                        }
                        parts.join("\n\n")
                    }
                }
            } else if request.tools_search && !unlocked_tools.contains(name) {
                format!("Error: 工具「{name}」尚未解鎖。請先呼叫 search_tools_and_skills 搜尋並解鎖後再呼叫。")
            } else if all_tool_defs.contains_key(name) && !mcp_tool_map.contains_key(name) {
                // Built-in tool. MCP tools also live in the catalog, so exclude them
                // here — they're handled below.
                if name == "web_search" {
                    let query = arguments.get("query").and_then(Value::as_str).unwrap_or("");
                    if query.is_empty() {
                        "Error: web_search 的 query 不可為空".to_string()
                    } else {
                        match perform_web_search(query).await {
                            Ok(s) => s,
                            Err(e) => format!("Error: {e}"),
                        }
                    }
                } else if name == "fetch_url" {
                    let url = arguments.get("url").and_then(Value::as_str).unwrap_or("");
                    if url.is_empty() {
                        "Error: fetch_url 的 url 不可為空".to_string()
                    } else {
                        match perform_fetch_url(url).await {
                            Ok(s) => s,
                            Err(e) => format!("Error: {e}"),
                        }
                    }
                } else if name == "execute_command" {
                    match perform_execute_command_streaming(
                        app_handle,
                        request,
                        round,
                        &endpoint,
                        &workspace_root,
                        call_id,
                        &arguments,
                    )
                    .await
                    {
                        Ok(s) => s,
                        Err(e) => format!("Error: {e}"),
                    }
                } else {
                    execute_tool(Some(app_handle), &workspace_root, name, &arguments)
                        .unwrap_or_else(|error| format!("Error: {error}"))
                }
            } else if let Some(&client_idx) = mcp_tool_map.get(name) {
                if let Some((server_name, client)) = mcp_clients.get_mut(client_idx) {
                    client
                        .call_tool(name, &arguments)
                        .await
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
        for (_, skill_content) in skills_to_inject {
            messages.push(serde_json::json!({ "role": "system", "content": skill_content }));
        }
        round_index += 1;

        // 等這一輪（含工具呼叫）完全跑完才檢查暫停請求，確保不會中斷一半的模型回應或工具執行。
        let pause_requested = pause_requests()
            .lock()
            .map(|mut set| set.remove(&request.item_id))
            .unwrap_or(false);
        if pause_requested {
            return Ok(AgentExecutionResult {
                endpoint,
                content: String::new(),
                stats: None,
                tool_calls: execution_logs,
                paused: true,
                resume_state: Some(serde_json::json!({
                    "messages": messages,
                    "roundIndex": round_index,
                })),
                actual_model: None,
            });
        }
    }

    Err(format!("工具呼叫超過 {max_iterations} 輪，已停止執行"))
}

#[tauri::command]
async fn execute_agent(
    app_handle: tauri::AppHandle,
    request: AgentExecutionRequest,
) -> Result<AgentExecutionResult, String> {
    if let Ok(mut map) = pending_agent_messages().lock() {
        map.remove(&request.item_id);
    }
    if let Ok(mut set) = pause_requests().lock() {
        set.remove(&request.item_id);
    }
    let mut request = request;
    request.api_key = resolve_env_key(&request.api_key);
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

    if !request.tools.is_empty()
        || request.mcp_servers.iter().any(|s| s.enabled)
        || request.tools_search
    {
        let res =
            execute_agent_with_tools(&app_handle, &request, base_url, input, has_parameters).await;
        if let Ok(mut map) = pending_agent_messages().lock() {
            map.remove(&request.item_id);
        }
        return res;
    }

    let has_user_prompt = has_parameters && !request.prompt.trim().is_empty();
    let skill_prompts = load_skill_prompts(&request.skills);
    let resumed_messages = request.resume_messages.clone();
    let body = if is_lm_studio_native {
        let input_for_body = if let Some(messages) = resumed_messages.as_ref() {
            serde_json::to_string_pretty(messages).unwrap_or_else(|_| input.clone())
        } else {
            input.clone()
        };
        let mut body = serde_json::json!({
            "model": request.model_name,
            "input": input_for_body,
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
            let merged = if existing.is_empty() {
                combined
            } else {
                format!("{existing}\n\n{combined}")
            };
            body["system_prompt"] = Value::String(merged);
        }
        body
    } else {
        let messages = if let Some(messages) = resumed_messages.clone() {
            messages
        } else {
            let mut messages = Vec::new();
            if has_user_prompt {
                messages.push(
                    serde_json::json!({ "role": "system", "content": request.prompt.clone() }),
                );
            }
            for (_, skill_content) in &skill_prompts {
                messages.push(serde_json::json!({ "role": "system", "content": skill_content }));
            }
            messages.push(serde_json::json!({ "role": "user", "content": input }));
            messages
        };
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
        if request.resume_messages.is_some() {
            annotate_resumed_message_sources(msgs);
        } else {
        let skill_count = skill_prompts.len();
        let user_input_idx = (has_user_prompt as usize) + skill_count;
        for (i, msg) in msgs.iter_mut().enumerate() {
            let source = if has_user_prompt && i == 0 {
                "📝 項目 Prompt".to_string()
            } else if i >= (has_user_prompt as usize)
                && i < (has_user_prompt as usize) + skill_count
            {
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
    }
    if is_lm_studio_native {
        if has_user_prompt || !skill_prompts.is_empty() {
            let mut sources = Vec::new();
            if has_user_prompt {
                sources.push("📝 項目 Prompt");
            }
            for _ in &skill_prompts {
                sources.push("📦 Skill");
            }
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
        let raw = json
            .get("output")
            .and_then(Value::as_array)
            .map(|outputs| {
                outputs
                    .iter()
                    .filter(|output| output.get("type").and_then(Value::as_str) == Some("message"))
                    .filter_map(|output| output.get("content").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        clean_assistant_content(&raw)
    } else {
        let raw = json
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        clean_assistant_content(&raw)
    };

    if let Ok(mut map) = pending_agent_messages().lock() {
        map.remove(&request.item_id);
    }

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
        paused: false,
        resume_state: None,
        actual_model: json
            .get("model_instance_id")
            .or_else(|| json.get("model"))
            .and_then(Value::as_str)
            .map(str::to_string),
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
    let mut agent = String::new();
    let mut agent_id = String::new();
    let mut action = String::new();
    let mut exec_id = String::new();
    let mut tools = Vec::new();
    let mut model = String::new();
    let mut parameters = serde_json::Map::new();

    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode_query_component(raw_key)?;
        let value = decode_query_component(raw_value)?;

        match key.as_str() {
            "agent" => {
                agent = value;
                continue;
            }
            "agent_id" | "agentId" => {
                agent_id = value;
                continue;
            }
            "action" => {
                action = value;
                continue;
            }
            "exec_id" | "execId" => {
                exec_id = value;
                continue;
            }
            "tools" | "tool" => {
                for t in value.split(',') {
                    let trimmed = t.trim().to_string();
                    if !trimmed.is_empty() {
                        tools.push(trimmed);
                    }
                }
                continue;
            }
            "model" | "model_name" | "modelName" => {
                model = value;
                continue;
            }
            _ => {}
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
        agent,
        agent_id,
        action,
        exec_id,
        tools,
        model,
        parameters: Value::Object(parameters),
    })
}

fn parse_post_input(body: &[u8]) -> Result<HttpInput, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| "body 必須是有效的 JSON".to_string())?;
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| "body 必須是 JSON object".to_string())?;
    let agent = object
        .remove("agent")
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let agent_id = object
        .remove("agent_id")
        .or_else(|| object.remove("agentId"))
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let action = object
        .remove("action")
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let exec_id = object
        .remove("exec_id")
        .or_else(|| object.remove("execId"))
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();

    let mut tools = Vec::new();
    if let Some(tools_val) = object.remove("tools").or_else(|| object.remove("tool")) {
        match tools_val {
            Value::String(s) => {
                for t in s.split(',') {
                    let trimmed = t.trim().to_string();
                    if !trimmed.is_empty() {
                        tools.push(trimmed);
                    }
                }
            }
            Value::Array(arr) => {
                for v in arr {
                    if let Some(s) = v.as_str() {
                        let trimmed = s.trim().to_string();
                        if !trimmed.is_empty() {
                            tools.push(trimmed);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let model = object
        .remove("model")
        .or_else(|| object.remove("model_name"))
        .or_else(|| object.remove("modelName"))
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();

    let parameters = object
        .remove("parameters")
        .or_else(|| object.remove("params"))
        .or_else(|| object.remove("input"))
        .unwrap_or(Value::Object(object));
    Ok(HttpInput {
        agent,
        agent_id,
        action,
        exec_id,
        tools,
        model,
        parameters,
    })
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
    // GET /session_file?path=... — 讀取 session JSON 檔（含安全性檢查）
    if endpoint == "/session_file" && method == "GET" {
        let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut req_path = String::new();
        for pair in query.split('&').filter(|p| !p.is_empty()) {
            let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
            if let (Ok(key), Ok(value)) = (
                decode_query_component(raw_key),
                decode_query_component(raw_value),
            ) {
                if key == "path" {
                    req_path = value;
                    break;
                }
            }
        }
        if req_path.is_empty() {
            write_http_response(
                &mut stream,
                "400 Bad Request",
                r#"{"error":"缺少 path 參數"}"#,
            );
            return;
        }
        // 安全：只允許讀取 .json 且路徑包含 ".ListAgent/session" 或 ".listagent/sessions"
        let looks_like_session = req_path.ends_with(".json")
            && (req_path.contains(".ListAgent/session")
                || req_path.contains(".ListAgent\\session")
                || req_path.contains(".listagent/sessions")
                || req_path.contains(".listagent\\sessions"));
        if !looks_like_session {
            write_http_response(
                &mut stream,
                "403 Forbidden",
                r#"{"error":"僅允許讀取 session 目錄下的 .json 檔"}"#,
            );
            return;
        }
        match fs::read_to_string(&req_path) {
            Ok(content) => write_http_response(&mut stream, "200 OK", &content),
            Err(error) => {
                let response = serde_json::json!({ "error": error.to_string() }).to_string();
                write_http_response(&mut stream, "404 Not Found", &response);
            }
        }
        return;
    }
    let json_file_path: Option<PathBuf> = match endpoint {
        "/agent_test_history" => Some(agent_test_history_path()),
        "/agent_test_autolist" => Some(agent_test_autolist_path()),
        _ => None,
    };
    if let Some(path) = json_file_path {
        match method.as_str() {
            "GET" => {
                let contents = fs::read_to_string(&path).unwrap_or_else(|_| "[]".to_string());
                write_http_response(&mut stream, "200 OK", &contents);
            }
            "POST" => {
                if serde_json::from_slice::<Value>(&body).is_err() {
                    write_http_response(
                        &mut stream,
                        "400 Bad Request",
                        r#"{"error":"body 必須是有效 JSON"}"#,
                    );
                    return;
                }
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                match fs::write(&path, &body) {
                    Ok(_) => write_http_response(&mut stream, "200 OK", r#"{"ok":true}"#),
                    Err(error) => {
                        let response =
                            serde_json::json!({ "error": error.to_string() }).to_string();
                        write_http_response(&mut stream, "500 Internal Server Error", &response);
                    }
                }
            }
            _ => write_http_response(
                &mut stream,
                "405 Method Not Allowed",
                r#"{"error":"僅接受 GET 或 POST"}"#,
            ),
        }
        return;
    }
    // Check if HTTP trigger is enabled in settings
    if let Ok(settings) = read_settings() {
        if !settings.enable_http_input {
            let response =
                serde_json::json!({ "error": "HTTP trigger is disabled in event settings" })
                    .to_string();
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
    input.agent_id = input.agent_id.trim().to_string();
    let action = {
        let a = input.action.trim();
        if a.is_empty() {
            "run".to_string()
        } else {
            a.to_string()
        }
    };

    // Resolve agent name from agent_id if provided (via settings lookup)
    if !input.agent_id.is_empty() && input.agent.is_empty() {
        if let Ok(settings) = read_settings() {
            if let Some(item) = settings
                .items
                .iter()
                .find(|it| it.agent_id == input.agent_id)
            {
                input.agent = item.name.clone();
            }
        }
    }

    // action=list_agents: 回傳 App 裡所有 items 的 { agentId, name }
    if action == "list_agents" {
        let items: Vec<ListItem> = read_settings().map(|s| s.items).unwrap_or_default();
        let list: Vec<Value> = items
            .iter()
            .map(|it| {
                serde_json::json!({
                    "agentId": it.agent_id,
                    "name": it.name,
                    "allowHttp": it.allow_http,
                })
            })
            .collect();
        write_http_response(
            &mut stream,
            "200 OK",
            &serde_json::json!({ "agents": list }).to_string(),
        );
        return;
    }

    // action=get_status doesn't run anything — just returns current agent state.
    if action == "get_status" {
        let snapshot = agent_status().lock().map(|s| s.clone()).unwrap_or_default();
        let filtered = if input.agent.is_empty() {
            serde_json::json!({
                "running": snapshot.running,
                "queued": snapshot.queued,
                "detail": snapshot.detail,
                "updatedAt": snapshot.updated_at
            })
        } else {
            let name = &input.agent;
            let detail = snapshot.detail.get(name).cloned().unwrap_or_default();
            serde_json::json!({
                "agent": name,
                "agentId": input.agent_id,
                "running": snapshot.running.iter().any(|n| n == name),
                "queued": snapshot.queued.get(name).copied().unwrap_or(0),
                "detail": detail,
                "updatedAt": snapshot.updated_at
            })
        };
        write_http_response(&mut stream, "200 OK", &filtered.to_string());
        return;
    }

    if action != "run" {
        let response = serde_json::json!({
            "error": format!("未知的 action：{action}（支援：run, get_status, list_agents）")
        })
        .to_string();
        write_http_response(&mut stream, "400 Bad Request", &response);
        return;
    }

    if input.agent.is_empty() || input.agent.chars().count() > 200 {
        write_http_response(
            &mut stream,
            "400 Bad Request",
            r#"{"error":"必須提供 agent（AGENT NAME）或 agent_id（找不到對應項目）"}"#,
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
    let response = serde_json::json!({
        "accepted": true,
        "agent": input.agent,
        "agentId": input.agent_id,
        "action": action
    })
    .to_string();
    write_http_response(&mut stream, "202 Accepted", &response);
}

fn start_http_server(queue: HttpInputQueue, app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(HTTP_SERVER_ADDRESS) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("HTTP server failed to bind {HTTP_SERVER_ADDRESS}: {error}");
                log::error!("HTTP server 無法啟動於 {HTTP_SERVER_ADDRESS}: {error}");
                return;
            }
        };

        eprintln!("HTTP server started at http://{HTTP_SERVER_ADDRESS}");
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
    fn get_input_without_agent_is_ok() {
        let input = parse_get_input("/input?message=hello").unwrap();
        assert_eq!(input.agent, "");
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
    fn get_input_parses_tools_parameter() {
        let input_comma =
            parse_get_input("/input?agent=test&tools=read_file,execute_command").unwrap();
        assert_eq!(input_comma.tools, vec!["read_file", "execute_command"]);

        // Since parse_get_input iterates and parameters.get_mut treats subsequent items as parameter override/array,
        // multiple "tools" query params will populate tools twice.
        let input_multi =
            parse_get_input("/input?agent=test&tools=read_file&tools=execute_command").unwrap();
        assert_eq!(input_multi.tools, vec!["read_file", "execute_command"]);
    }

    #[test]
    fn post_input_parses_tools_parameter() {
        let body_str = r#"{"agent":"test","tools":"read_file,execute_command"}"#;
        let input_str = parse_post_input(body_str.as_bytes()).unwrap();
        assert_eq!(input_str.tools, vec!["read_file", "execute_command"]);

        let body_arr = r#"{"agent":"test","tools":["read_file","execute_command"]}"#;
        let input_arr = parse_post_input(body_arr.as_bytes()).unwrap();
        assert_eq!(input_arr.tools, vec!["read_file", "execute_command"]);
    }

    #[test]
    fn get_input_parses_model_parameter() {
        let input = parse_get_input("/input?agent=test&model=gpt-4o").unwrap();
        assert_eq!(input.model, "gpt-4o");

        let input_name = parse_get_input("/input?agent=test&model_name=claude-3-5").unwrap();
        assert_eq!(input_name.model, "claude-3-5");
    }

    #[test]
    fn post_input_parses_model_parameter() {
        let body = r#"{"agent":"test","model":"gpt-4o"}"#;
        let input = parse_post_input(body.as_bytes()).unwrap();
        assert_eq!(input.model, "gpt-4o");

        let body_camel = r#"{"agent":"test","modelName":"claude-3-5"}"#;
        let input_camel = parse_post_input(body_camel.as_bytes()).unwrap();
        assert_eq!(input_camel.model, "claude-3-5");
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
                execute_tool(
                    None,
                    &root,
                    "read_file",
                    &serde_json::json!({ "path": file })
                )?,
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

    #[test]
    fn read_file_pages_with_offset_and_limit() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        let unique = format!(
            "target/tool-test-paging-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let directory = root.join(&unique);
        fs::create_dir_all(&directory).unwrap();

        let result = (|| -> Result<(), String> {
            let file = format!("{unique}/lines.txt");
            let lines: Vec<String> = (1..=10).map(|i| format!("line{i}")).collect();
            execute_tool(
                None,
                &root,
                "write_file",
                &serde_json::json!({ "path": file.clone(), "content": lines.join("\n") }),
            )?;

            // 未指定 offset/limit：短檔案照舊回傳全文
            let whole = execute_tool(
                None,
                &root,
                "read_file",
                &serde_json::json!({ "path": file.clone() }),
            )?;
            assert_eq!(whole, lines.join("\n"));

            // 指定 offset/limit：只回傳該範圍，並附上截斷提示
            let paged = execute_tool(
                None,
                &root,
                "read_file",
                &serde_json::json!({ "path": file.clone(), "offset": 3, "limit": 2 }),
            )?;
            assert!(paged.starts_with("line3\nline4"));
            assert!(paged.contains("已截斷"));
            assert!(!paged.contains("line5"));

            // offset 超出檔案範圍
            let out_of_range = execute_tool(
                None,
                &root,
                "read_file",
                &serde_json::json!({ "path": file, "offset": 100, "limit": 2 }),
            )?;
            assert!(out_of_range.contains("超出範圍"));
            Ok(())
        })();

        fs::remove_dir_all(directory).unwrap();
        result.unwrap();
    }

    #[test]
    fn execute_command_runs_in_workspace_and_returns_output() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        let current_exe = std::env::current_exe().unwrap();
        let output = execute_tool(
            None,
            &root,
            "execute_command",
            &serde_json::json!({
                "command": current_exe.to_string_lossy(),
                "args": [
                    "--ignored",
                    "--exact",
                    "tests::execute_command_helper_prints_marker",
                    "--nocapture"
                ],
                "timeout_seconds": 30
            }),
        )
        .unwrap();
        let json: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(json["success"], true);
        assert_eq!(json["timed_out"], false);
        assert!(json["stdout"]
            .as_str()
            .unwrap()
            .contains("LISTAGENT_EXECUTE_COMMAND_OK"));
    }

    #[test]
    fn execute_command_arguments_recover_timeout_outside_args() {
        let raw = r#"{"command": "cmd", "args": ["/c","dir /s /b \"C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\*\\bin\\Hostx64\\x64\\nmake.exe\" 2>nul","timeout_seconds":15]}"#;
        let parsed = parse_tool_arguments("execute_command", raw).unwrap();
        assert_eq!(parsed["command"], "cmd");
        assert_eq!(parsed["timeout_seconds"], 15);
        assert_eq!(parsed["args"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["args"][0], "/c");
        assert!(parsed["args"][1].as_str().unwrap().contains("nmake.exe"));
    }

    #[test]
    fn execute_command_timeout_schema_allows_long_builds() {
        let defs = tool_definitions(&["execute_command".to_string()]).unwrap();
        assert_eq!(
            defs[0]["function"]["parameters"]["properties"]["timeout_seconds"]["maximum"],
            MAX_COMMAND_TIMEOUT_SECONDS
        );
    }

    #[test]
    #[ignore]
    fn execute_command_helper_prints_marker() {
        println!("LISTAGENT_EXECUTE_COMMAND_OK");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let input_queue = HttpInputQueue::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(input_queue.clone())
        .setup(|app| {
            system_prompt_config(); // 啟動時載入並快取 system_prompt.json（首次呼叫觸發讀檔）
            if cfg!(debug_assertions) {
                if let Err(err) = app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                ) {
                    eprintln!("failed to initialize debug log plugin: {err}");
                }
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
            read_skill,
            save_skill,
            delete_skill,
            list_mcp_server_tools,
            update_agent_status,
            send_agent_message,
            request_pause_agent,
            cancel_pause_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
