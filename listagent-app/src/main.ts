import './style.css'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

// ============================================================
// Tauri 偵測與設定檔存取層
// ============================================================

/** 是否在 Tauri 桌面環境中執行 */
function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__
}

interface SettingsFile {
  items: PersistedListItem[]
  userPresets: Preset[]
  builtinPresets: Preset[]
  events: ScheduledEvent[]
  enableHttpInput?: boolean
  eventMappings?: EventMapping[]
  embeddingApiBaseUrl?: string
  embeddingApiKey?: string
  embeddingModel?: string
}

interface SkillMeta {
  id: string
  name: string
  description: string
}

interface McpServerConfig {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  env: Record<string, string>
  url: string
}

interface ListItem {
  id: number
  code: string
  agentId: string
  name: string
  prompt: string
  apiBaseUrl: string
  apiKey: string
  modelName: string
  workingDirectory: string
  tools: ToolName[]
  skills: string[]
  mcpServers: McpServerConfig[]
  mcpTools: string[]
  memory: boolean
  allowHttp: boolean
  toolsSearch: boolean
  embeddingApiBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  maxRounds: number
}

type PersistedListItem = Omit<ListItem, 'code'>

interface Preset {
  name: string
  apiBaseUrl: string
  apiKey: string
  modelName: string
}

interface HttpInput {
  agent: string
  agentId?: string
  parameters: unknown
  execId?: string
}

interface EventMapping {
  id: string
  eventId: string
  agentId: number
}

type ToolName = 'list_directory' | 'search_content' | 'read_file' | 'write_file' | 'replace_string' | 'trigger_event' | 'web_search' | 'fetch_url' | 'get_current_time' | 'execute_command'

const TOOL_NAMES: ToolName[] = ['list_directory', 'search_content', 'read_file', 'write_file', 'replace_string', 'trigger_event', 'web_search', 'fetch_url', 'get_current_time', 'execute_command']

interface AgentExecutionResult {
  endpoint: string
  content: string
  stats?: unknown
}

interface ModelExchangeEvent {
  itemId: number
  round: number
  phase: 'request' | 'response' | 'tool' | 'error' | 'vector_search' | 'user_input' | 'command_output'
  endpoint: string
  payload: unknown
}

interface SessionExchange {
  round: number
  phase: 'request' | 'response' | 'tool' | 'error' | 'vector_search' | 'user_input' | 'command_output'
  endpoint: string
  payload: unknown
  timestamp: number
}

interface SessionData {
  sessionId: string
  startedAt: number
  endedAt?: number
  itemId: number
  itemName: string
  modelName: string
  apiBaseUrl: string
  logs?: LogEntry[]
  exchanges: SessionExchange[]
}

interface SessionFileMeta {
  filename: string
  path: string
  modifiedAt: number
}

interface ScheduledEvent {
  id: string
  triggerAt: number
  agentId: number
  recurrence: 'once' | 'interval'
  intervalSeconds?: number
  executedAt?: number
  executionCount: number
}

const DEFAULT_PRESETS: Preset[] = [
  { name: 'OpenAI', apiBaseUrl: 'https://api.openai.com/v1', apiKey: '', modelName: 'gpt-4o' },
  { name: 'Azure OpenAI', apiBaseUrl: 'https://YOUR_RESOURCE.openai.azure.com', apiKey: '', modelName: 'gpt-4o' },
  { name: 'Ollama (本地)', apiBaseUrl: 'http://localhost:11434/v1', apiKey: '', modelName: 'llama3' },
  { name: 'LM Studio (Local)', apiBaseUrl: 'http://localhost:1234/api/v1', apiKey: '', modelName: '' },
  { name: 'Anthropic Claude', apiBaseUrl: 'https://api.anthropic.com/v1', apiKey: '', modelName: 'claude-3-opus-20240229' },
  { name: 'Google Gemini', apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '', modelName: 'gemini-pro' },
  { name: 'DeepSeek', apiBaseUrl: 'https://api.deepseek.com/v1', apiKey: '', modelName: 'deepseek-chat' },
  { name: 'Groq', apiBaseUrl: 'https://api.groq.com/openai/v1', apiKey: '', modelName: 'llama3-70b-8192' },
  { name: 'Together AI', apiBaseUrl: 'https://api.together.xyz/v1', apiKey: '', modelName: 'mistralai/Mixtral-8x7B-Instruct-v0.1' },
]

const STORAGE_KEY_PRESETS = 'listagent_user_presets'
const STORAGE_KEY_ITEMS = 'listagent_items'
const STORAGE_KEY_NEXT_ID = 'listagent_next_id'
const STORAGE_KEY_EVENTS = 'listagent_events'
// STORAGE_KEY_ENABLE_HTTP has been removed
const STORAGE_KEY_EVENT_MAPPINGS = 'listagent_event_mappings'

// ============================================================
// 應用狀態
// ============================================================

let items: ListItem[] = []
let nextId = 1
let editingItemId: number | null = null
let selectedItemId: number | null = null
let scheduledEvents: ScheduledEvent[] = []
let checkingScheduledEvents = false
let clockPhase: 'hour' | 'minute' = 'hour'
let clockHour24 = 12
let clockMinute = 0
// enableHttpInput global state has been removed
let eventMappings: EventMapping[] = []

/** 由持久化 id 確定性產生 4 碼顯示代碼，不需另存 code 欄位 */
function itemCodeFromId(id: number): string {
  const code = id.toString(36).toUpperCase()
  if (code.length > 4) throw new Error('item id 已超出 4 碼代碼可表示的範圍')
  return code.padStart(4, '0')
}

/** 產生一個新的、穩定的 agent_id — 之後不再改變（即使 item 改名） */
function generateAgentId(): string {
  const rand = (globalThis.crypto?.randomUUID?.() ?? '').replace(/-/g, '').slice(0, 12)
  return 'ag_' + (rand || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))
}

function hydrateItems(storedItems: PersistedListItem[]): ListItem[] {
  return storedItems.map((item) => ({
    ...item,
    code: itemCodeFromId(item.id),
    // 舊資料沒有 agentId，這裡自動補一個穩定 ID（下次 saveItems 就會存下來）
    agentId: typeof item.agentId === 'string' && item.agentId ? item.agentId : generateAgentId(),
    workingDirectory: typeof item.workingDirectory === 'string' ? item.workingDirectory : '',
    tools: Array.isArray(item.tools)
      ? item.tools.filter((tool): tool is ToolName => TOOL_NAMES.includes(tool as ToolName))
      : [],
    skills: Array.isArray(item.skills) ? item.skills.filter((s): s is string => typeof s === 'string') : [],
    mcpServers: Array.isArray(item.mcpServers) ? item.mcpServers : [],
    mcpTools: Array.isArray(item.mcpTools) ? item.mcpTools : [],
    memory: typeof item.memory === 'boolean' ? item.memory : false,
    allowHttp: typeof item.allowHttp === 'boolean' ? item.allowHttp : false,
    toolsSearch: typeof item.toolsSearch === 'boolean' ? item.toolsSearch : false,
    embeddingApiBaseUrl: typeof item.embeddingApiBaseUrl === 'string' ? item.embeddingApiBaseUrl : '',
    embeddingApiKey: typeof item.embeddingApiKey === 'string' ? item.embeddingApiKey : '',
    embeddingModel: typeof item.embeddingModel === 'string' ? item.embeddingModel : '',
    maxRounds: typeof item.maxRounds === 'number' && item.maxRounds > 0 ? item.maxRounds : 100,
  }))
}

function getPersistedItems(): PersistedListItem[] {
  return items.map((item) => ({
    id: item.id,
    agentId: item.agentId,
    name: item.name,
    prompt: item.prompt,
    apiBaseUrl: item.apiBaseUrl,
    apiKey: item.apiKey,
    modelName: item.modelName,
    workingDirectory: item.workingDirectory,
    tools: item.tools,
    skills: item.skills,
    mcpServers: item.mcpServers,
    mcpTools: item.mcpTools,
    memory: item.memory,
    allowHttp: item.allowHttp,
    toolsSearch: item.toolsSearch,
    embeddingApiBaseUrl: item.embeddingApiBaseUrl,
    embeddingApiKey: item.embeddingApiKey,
    embeddingModel: item.embeddingModel,
    maxRounds: item.maxRounds,
  }))
}

function itemNameKey(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase()
}

function generateUniqueItemName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(itemNameKey(baseName))) return baseName

  let suffix = 2
  while (usedNames.has(itemNameKey(`${baseName} (${suffix})`))) suffix++
  return `${baseName} (${suffix})`
}

/** 確保舊資料中的項目名稱也符合唯一性限制 */
function ensureUniqueItemNames(loadedItems: ListItem[]): boolean {
  const usedNames = new Set<string>()
  let changed = false

  loadedItems.forEach((item) => {
    const baseName = item.name.trim() || `項目 ${item.id}`
    const uniqueName = generateUniqueItemName(baseName, usedNames)
    if (item.name !== uniqueName) {
      item.name = uniqueName
      changed = true
    }
    usedNames.add(itemNameKey(uniqueName))
  })

  return changed
}

function generateDefaultItemName(): string {
  const usedNames = new Set(items.map((item) => itemNameKey(item.name)))
  let index = 1
  while (usedNames.has(itemNameKey(`項目 ${index}`))) index++
  return `項目 ${index}`
}

/** 每個 item 獨立的日誌記錄（id → 日誌行陣列） */
const itemLogs: Map<number, LogEntry[]> = new Map()

/** 每個 item 目前執行中的 session exchanges（id → exchanges） */
const currentSessionExchanges: Map<number, SessionExchange[]> = new Map()

/** 每個 item 目前 session 的開始時間 */
const currentSessionStartedAt: Map<number, number> = new Map()

/** 每個 item 目前 session 的固定 id / filename / saved path */
const currentSessionIds: Map<number, string> = new Map()
const currentSessionFilenames: Map<number, string> = new Map()
const currentSessionSavedPaths: Map<number, string> = new Map()

/** 節流寫入目前 session，避免 command output 大量 flush 壓垮 UI / IO */
const currentSessionFlushTimers: Map<number, number> = new Map()
const currentSessionWriteChains: Map<number, Promise<void>> = new Map()

/** 右側面板目前正在查看的歷史 session（null = 即時執行過程） */
let viewingSessionData: SessionData | null = null

/** 目前已載入的歷史 session 清單 */
let loadedSessions: SessionFileMeta[] = []

/** 目前正在查看的 session 路徑 */
let viewingSessionPath: string | null = null

/** 目前正在等待模型回應的 item */
const runningItems = new Set<number>()

interface AgentTaskDetail {
  currentRound?: number
  currentTokens?: number
  lastEndedAt?: number
  lastSuccess?: boolean
  lastContentPreview?: string
  lastTokens?: number
  lastRounds?: number
  currentExecId?: string
  lastExecId?: string
  lastSessionPath?: string
  lastSessionUrl?: string
  lastPromptTokens?: number
  lastCachedTokens?: number
}

/** 每個 agent name 的上一次任務結果（跨 runItem 執行保留） */
const lastTaskByAgent = new Map<string, AgentTaskDetail>()

/** 每個 item 目前執行中 task 的 execId（來自 HTTP request 的 exec_id 參數） */
const currentExecIdByItem = new Map<number, string>()

/** 從 currentSessionExchanges 抓目前跑到第幾 round + 累積 tokens */
function getCurrentTaskInfo(itemId: number): { currentRound: number, currentTokens: number } | null {
  const exchanges = currentSessionExchanges.get(itemId)
  if (!exchanges || exchanges.length === 0) return null
  let maxRound = 0
  let totalTokens = 0
  exchanges.forEach((ex) => {
    if (ex.phase !== 'response') return
    if (ex.round > maxRound) maxRound = ex.round
    const u = extractUsage(ex.payload)
    if (u) totalTokens += u.total
  })
  return { currentRound: maxRound, currentTokens: totalTokens }
}

/** 把目前的 running/queued 狀態同步到 Rust，讓 HTTP action=get_status 能查詢到 */
function syncAgentStatus(): void {
  if (!isTauri()) return
  const running: string[] = []
  const queued: Record<string, number> = {}
  const detail: Record<string, AgentTaskDetail> = {}

  // Running agents：帶當下的 round + tokens；也 merge 上一次任務資訊
  runningItems.forEach((id) => {
    const item = items.find((i) => i.id === id)
    if (!item) return
    running.push(item.name)
    const cur = getCurrentTaskInfo(id)
    const last = lastTaskByAgent.get(item.name)
    const entry: AgentTaskDetail = { ...(last ?? {}) }
    if (cur) {
      entry.currentRound = cur.currentRound
      entry.currentTokens = cur.currentTokens
    }
    const execId = currentExecIdByItem.get(id)
    if (execId) entry.currentExecId = execId
    detail[item.name] = entry
  })

  itemTaskQueues.forEach((q, id) => {
    const item = items.find((i) => i.id === id)
    if (item && q.length > 0) queued[item.name] = q.length
  })

  // 沒在跑的 agent 也把最後一次結果帶上
  lastTaskByAgent.forEach((info, name) => {
    if (!detail[name]) detail[name] = { ...info }
  })

  void invoke('update_agent_status', { running, queued, detail }).catch(() => {})
}

interface QueuedTask {
  parameters?: unknown
  enqueuedAt: number
  execId?: string
}

/** 每個 item 各自的 FIFO 任務佇列 */
const itemTaskQueues = new Map<number, QueuedTask[]>()
const MAX_QUEUED_TASKS_PER_ITEM = 1000

/** 將 HTTP arg1/arg2/arg3 套入 Prompt 模板 */
function resolvePromptArguments(prompt: string, parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return prompt

  let resolved = prompt
  const values = parameters as Record<string, unknown>
  ;(['message', 'arg1', 'arg2', 'arg3'] as const).forEach((name) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return
    const rawValue = values[name]
    const value = typeof rawValue === 'string'
      ? rawValue
      : rawValue == null
        ? ''
        : typeof rawValue === 'object'
          ? JSON.stringify(rawValue)
          : String(rawValue)
    resolved = resolved.split(`{${name}}`).join(value)
  })
  return resolved
}

/** 即時記錄每一輪與 AI Model 的 request / response / tool exchange */
function recordModelExchange(exchange: ModelExchangeEvent): void {
  if (!itemLogs.has(exchange.itemId)) itemLogs.set(exchange.itemId, [])
  const logs = itemLogs.get(exchange.itemId)!
  const now = Date.now()

  // command_output is high-frequency streaming data. Keep one live black box in
  // the UI, but still append every output event to session exchanges below.
  if (exchange.phase === 'command_output') {
    const entry = upsertCommandOutputLog(logs, exchange.payload, now)
    appendSessionExchange(exchange, now)
    if (selectedItemId === exchange.itemId && viewingSessionData === null) {
      if (!updateLiveCommandOutputBox(entry)) {
        renderMessageBox(exchange.itemId)
      }
    }
    return
  }

  const payload = JSON.stringify(exchange.payload, null, 2)
  const phaseLabels = {
    request: '→ 發送給 AI Model',
    response: '← AI Model 回應',
    tool: '⚙ Tool 執行',
    error: '✖ AI Model 錯誤',
    vector_search: '🔍 向量搜尋 tools',
    user_input: '💬 使用者插話',
    command_output: '🖥 Command 輸出',
  } as const
  const levels: Record<ModelExchangeEvent['phase'], LogLevel> = {
    request: 'info',
    response: 'success',
    tool: 'system',
    error: 'error',
    vector_search: 'system',
    user_input: 'info',
    command_output: 'system',
  }
  logs.push({
    level: levels[exchange.phase],
    message: `[AI Round ${exchange.round}] ${phaseLabels[exchange.phase]}\nEndpoint：${exchange.endpoint}\n${payload}`,
    timestamp: now,
    kind: 'detail',
  })
  const simpleEntry = makeSimpleExchangeEntry(exchange.phase, exchange.round, exchange.payload, now)
  if (simpleEntry) logs.push(simpleEntry)

  // 每輪 response 後補一行 token 用量（簡化 & 詳細模式都顯示）
  if (exchange.phase === 'response') {
    const usage = extractUsage(exchange.payload)
    if (usage) {
      logs.push({
        level: 'info',
        message: `📊 Round ${exchange.round} tokens：${formatUsage(usage)}`,
        timestamp: now + 0.5,
      })
    }
    // 也同步一次 status，讓 HTTP get_status 能拿到最新的 round + 累積 tokens
    syncAgentStatus()
  }

  // 同步紀錄到 session exchanges
  appendSessionExchange(exchange, now)

  if (selectedItemId === exchange.itemId && viewingSessionData === null) {
    renderMessageBox(exchange.itemId)
  }
}

function appendSessionExchange(exchange: ModelExchangeEvent, timestamp: number): void {
  if (!currentSessionExchanges.has(exchange.itemId)) {
    currentSessionExchanges.set(exchange.itemId, [])
  }
  currentSessionExchanges.get(exchange.itemId)!.push({
    round: exchange.round,
    phase: exchange.phase,
    endpoint: exchange.endpoint,
    payload: exchange.payload,
    timestamp,
  })
  const item = items.find((candidate) => candidate.id === exchange.itemId)
  if (item) {
    scheduleLiveSessionFlush(item, exchange.phase === 'command_output' ? 1000 : 100)
  }
}

/** 日誌行類型 */
type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'system'

interface LogEntry {
  level: LogLevel
  message: string
  timestamp: number
  /** 'detail' = raw AI JSON (詳細模式顯示)；'simple' = 可讀摘要（簡化模式顯示）；undefined = 永遠顯示 */
  kind?: 'detail' | 'simple'
  /** 若提供，簡化模式渲染時用此 HTML 取代 escapeHtml(message)。內容必須已安全處理。 */
  html?: string
  commandOutputKey?: string
  commandOutputLines?: string[]
  commandOutputTitle?: string
}

// ============================================================
// 表格框線樣式
// ============================================================

/** 表格框線樣式設定 */
interface TableBorderStyle {
  /** 框線粗細 (px)，預設 1 */
  borderWidth?: number
  /** 框線顏色 (CSS color)，預設 rgba(255,255,255,0.15) */
  borderColor?: string
  /** 框線樣式，預設 solid */
  borderStyle?: 'solid' | 'dashed' | 'dotted' | 'double'
  /** 表頭框線粗細 (px)，若不指定則沿用 borderWidth */
  headerBorderWidth?: number
  /** 表頭框線顏色，若不指定則沿用 borderColor */
  headerBorderColor?: string
  /** 儲存格內邊距 (CSS padding 值)，預設 4px 10px */
  cellPadding?: string
  /** 僅繪製外框線（不含內部格線），預設 false */
  outerBorderOnly?: boolean
  /** 完全隱藏框線，預設 false（優先於 outerBorderOnly） */
  noBorder?: boolean
  /** 是否啟用合併儲存格（支援 > 與 ^^ 語法），預設 false */
  mergeCells?: boolean
}

/** 全域預設表格框線樣式，所有未指定 borderStyle 的 renderMarkdownSafe 呼叫皆會套用 */
let defaultTableBorderStyle: TableBorderStyle = {}

/** 設定全域預設表格框線樣式 */
function setDefaultTableBorderStyle(style: TableBorderStyle): void {
  defaultTableBorderStyle = style
}

/** 取得目前的全域預設表格框線樣式 */
function getDefaultTableBorderStyle(): TableBorderStyle {
  return { ...defaultTableBorderStyle }
}

// 將公開 API 函式標記為已使用（供外部程式碼呼叫）
void setDefaultTableBorderStyle
void getDefaultTableBorderStyle

/** 將 TableBorderStyle 轉為 HTML style 屬性字串（CSS 自訂屬性） */
function borderStyleToStyleAttr(bs: TableBorderStyle): string {
  const parts: string[] = []
  if (bs.borderWidth !== undefined) parts.push(`--md-border-width:${bs.borderWidth}px`)
  if (bs.borderColor !== undefined) parts.push(`--md-border-color:${bs.borderColor}`)
  if (bs.borderStyle !== undefined) parts.push(`--md-border-style:${bs.borderStyle}`)
  if (bs.headerBorderWidth !== undefined) parts.push(`--md-header-border-width:${bs.headerBorderWidth}px`)
  if (bs.headerBorderColor !== undefined) parts.push(`--md-header-border-color:${bs.headerBorderColor}`)
  if (bs.cellPadding !== undefined) parts.push(`--md-cell-padding:${bs.cellPadding}`)
  if (bs.outerBorderOnly !== undefined) parts.push(`--md-outer-only:${bs.outerBorderOnly ? '1' : '0'}`)
  if (bs.noBorder !== undefined) parts.push(`--md-no-border:${bs.noBorder ? '1' : '0'}`)
  return parts.length > 0 ? ` style="${parts.join(';')}"` : ''
}

// ============================================================
// DOM 元素參照
// ============================================================

const btnAdd = document.getElementById('btn-add') as HTMLButtonElement
const btnEvents = document.getElementById('btn-events') as HTMLButtonElement
const listContainer = document.getElementById('list-container') as HTMLElement
const emptyState = document.getElementById('empty-state') as HTMLElement

// 設定對話框元素
const settingsOverlay = document.getElementById('settings-overlay') as HTMLElement
const btnCloseDialog = document.getElementById('btn-close-dialog') as HTMLButtonElement
const inputName = document.getElementById('input-name') as HTMLInputElement
const inputAgentId = document.getElementById('input-agent-id') as HTMLInputElement
const btnCopyAgentId = document.getElementById('btn-copy-agent-id') as HTMLButtonElement
btnCopyAgentId?.addEventListener('click', () => {
  if (!inputAgentId.value) return
  void navigator.clipboard.writeText(inputAgentId.value).then(() => {
    const prev = btnCopyAgentId.textContent
    btnCopyAgentId.textContent = '✓ 已複製'
    setTimeout(() => { btnCopyAgentId.textContent = prev }, 1200)
  })
})
const inputPrompt = document.getElementById('input-prompt') as HTMLTextAreaElement
const inputApiBaseUrl = document.getElementById('input-api-base-url') as HTMLInputElement
const inputApiKey = document.getElementById('input-api-key') as HTMLInputElement
const inputModelName = document.getElementById('input-model-name') as HTMLInputElement
const inputWorkingDirectory = document.getElementById('input-working-directory') as HTMLInputElement
const btnSelectWorkingDirectory = document.getElementById('btn-select-working-directory') as HTMLButtonElement
const toolCheckboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="agent-tool"]'))
const inputMemory = document.getElementById('input-memory') as HTMLInputElement
const inputToolsSearch = document.getElementById('input-tools-search') as HTMLInputElement
const inputMaxRounds = document.getElementById('input-max-rounds') as HTMLInputElement
const inputEmbeddingBaseUrl = document.getElementById('input-global-embedding-base-url') as HTMLInputElement
const inputEmbeddingApiKey = document.getElementById('input-global-embedding-api-key') as HTMLInputElement
const inputEmbeddingModel = document.getElementById('input-global-embedding-model') as HTMLInputElement
const skillListEl = document.getElementById('skill-list') as HTMLElement
const selectPreset = document.getElementById('select-preset') as HTMLSelectElement
const btnSavePreset = document.getElementById('btn-save-preset') as HTMLButtonElement
const btnSave = document.getElementById('btn-save') as HTMLButtonElement
const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement
const btnDelete = document.getElementById('btn-delete') as HTMLButtonElement

// 全域設定視窗元素
const globalSettingsOverlay = document.getElementById('global-settings-overlay') as HTMLElement
const btnGlobalSettings = document.getElementById('btn-global-settings') as HTMLButtonElement
const btnCloseGlobalSettings = document.getElementById('btn-close-global-settings') as HTMLButtonElement
const btnGlobalSettingsSave = document.getElementById('btn-global-settings-save') as HTMLButtonElement
const btnGlobalSettingsCancel = document.getElementById('btn-global-settings-cancel') as HTMLButtonElement
const execFontSizeVal = document.getElementById('exec-font-size-val') as HTMLElement
const btnExecFontInc = document.getElementById('btn-exec-font-inc') as HTMLButtonElement
const btnExecFontDec = document.getElementById('btn-exec-font-dec') as HTMLButtonElement

let globalEmbeddingApiBaseUrl = ''
let globalEmbeddingApiKey = ''
let globalEmbeddingModel = ''
let execFontSize = 13

// 排程事件視窗元素
const eventsOverlay = document.getElementById('events-overlay') as HTMLElement
const btnCloseEvents = document.getElementById('btn-close-events') as HTMLButtonElement
const btnCloseEventsFooter = document.getElementById('btn-close-events-footer') as HTMLButtonElement
const inputEventDate = document.getElementById('input-event-date') as HTMLInputElement
const clockTimeBtn = document.getElementById('clock-time-btn') as HTMLButtonElement
const clockPopup = document.getElementById('clock-popup') as HTMLElement
const btnAm = document.getElementById('btn-am') as HTMLButtonElement
const btnPm = document.getElementById('btn-pm') as HTMLButtonElement
const clockDispHour = document.getElementById('clock-disp-hour') as HTMLElement
const clockDispMinute = document.getElementById('clock-disp-minute') as HTMLElement
const clockSvg = document.getElementById('clock-svg') as unknown as SVGSVGElement
const clockPopupHint = document.getElementById('clock-popup-hint') as HTMLElement
const selectEventAgent = document.getElementById('select-event-agent') as HTMLSelectElement
const selectEventRecurrence = document.getElementById('select-event-recurrence') as HTMLSelectElement
const eventIntervalFields = document.getElementById('event-interval-fields') as HTMLElement
const inputEventInterval = document.getElementById('input-event-interval') as HTMLInputElement
const selectEventIntervalUnit = document.getElementById('select-event-interval-unit') as HTMLSelectElement
const btnAddEvent = document.getElementById('btn-add-event') as HTMLButtonElement
const eventsList = document.getElementById('events-list') as HTMLElement
const httpAgentsList = document.getElementById('http-agents-list') as HTMLElement
const inputMappingEventId = document.getElementById('input-mapping-event-id') as HTMLInputElement
const selectMappingAgent = document.getElementById('select-mapping-agent') as HTMLSelectElement
const btnAddMapping = document.getElementById('btn-add-mapping') as HTMLButtonElement
const eventMappingsList = document.getElementById('event-mappings-list') as HTMLElement

// 訊息框元素
const msgContent = document.getElementById('message-content') as HTMLElement
const msgItemName = document.getElementById('msg-item-name') as HTMLElement
const msgPanelTitle = document.getElementById('msg-panel-title') as HTMLElement
const sessionListEl = document.getElementById('session-list') as HTMLElement
const agentUserInput = document.getElementById('agent-user-input') as HTMLTextAreaElement
const btnSendMessage = document.getElementById('btn-send-message') as HTMLButtonElement


// 分隔條元素
const splitter = document.getElementById('splitter') as HTMLElement
const messageBox = document.getElementById('message-box') as HTMLElement
const vsplitter = document.getElementById('vsplitter') as HTMLElement
const sessionHistoryPanel = document.getElementById('session-history-panel') as HTMLElement

// Skills 清單（設定對話框開啟時從後端載入）
let availableSkills: SkillMeta[] = []

// 簡化／詳細切換
const btnViewToggle = document.getElementById('btn-view-toggle') as HTMLButtonElement
let viewDetailed = false

// 卡片／列表檢視切換
const btnListViewToggle = document.getElementById('btn-list-view-toggle') as HTMLButtonElement
type ViewMode = 'card' | 'list'
const VIEW_MODE_KEY = 'listagent_view_mode'
let listViewMode: ViewMode = 'card'

// 水平分隔條拖曳狀態
let splitterDragging = false
let splitterStartY = 0
let splitterStartHeight = 0
const SPLITTER_HEIGHT_KEY = 'listagent_splitter_height'

// 垂直分隔條拖曳狀態
let vsplitterDragging = false
let vsplitterStartX = 0
let vsplitterStartWidth = 0
const VSPLITTER_WIDTH_KEY = 'listagent_vsplitter_width'

// ============================================================
// 渲染函式
// ============================================================

/** 渲染整個列表 */
function renderList(): void {
  listContainer.innerHTML = ''

  if (items.length === 0) {
    emptyState.classList.remove('hidden')
    listContainer.classList.add('hidden')
    return
  }

  emptyState.classList.add('hidden')
  listContainer.classList.remove('hidden')

  // 切換容器佈局模式
  if (listViewMode === 'card') {
    listContainer.classList.add('card-layout')
  } else {
    listContainer.classList.remove('card-layout')
  }

  if (listViewMode === 'list') {
    items.forEach((item) => {
      const row = createItemListRow(item)
      listContainer.appendChild(row)
    })
  } else {
    items.forEach((item) => {
      const card = createItemCard(item)
      listContainer.appendChild(card)
    })
  }
}

/** 建立單一項目卡片 */
function createItemCard(item: ListItem): HTMLElement {
  const card = document.createElement('div')
  card.className = 'item-card'
  card.dataset.id = String(item.id)

  // 若目前選中此項目，套用 selected 樣式
  if (selectedItemId === item.id) {
    card.classList.add('selected')
  }

  // 若此項目正在執行中，套用執行中樣式
  if (runningItems.has(item.id)) {
    card.classList.add('has-running-agent')
  }

  const itemEvents = scheduledEvents.filter((event) => event.agentId === item.id)
  const activeEvents = itemEvents.filter((event) => event.recurrence === 'interval' || !event.executedAt)
  const eventIcon = document.createElement('span')
  if (itemEvents.length > 0) {
    eventIcon.className = `item-event-icon${activeEvents.length > 0 ? ' active' : ''}`
    eventIcon.textContent = '⏰'
    eventIcon.title = `事件：${itemEvents.length}（待執行／循環：${activeEvents.length}）`
  }

  // 圖示列（卡片頂部）
  const iconsRow = document.createElement('div')
  iconsRow.className = 'card-icons-row'

  // 項目資訊
  const info = document.createElement('div')
  info.className = 'item-info'

  const nameEl = document.createElement('span')
  nameEl.className = 'item-name'
  nameEl.textContent = item.name

  const metaEl = document.createElement('span')
  metaEl.className = 'item-meta'
  metaEl.textContent = formatMeta(item)

  info.appendChild(nameEl)
  info.appendChild(metaEl)

  // 執行狀態的轉圈圈（放在按鈕左邊；running=1 + queued=N 個）
  const spinners = document.createElement('span')
  spinners.className = 'run-spinners'
  renderSpinners(spinners, item.id)

  // 執行按鈕（永遠是 ▶️，即使在跑也能按 → 進 queue）
  const runBtn = document.createElement('button')
  runBtn.className = 'btn-run'
  runBtn.innerHTML = '▶️'
  runBtn.title = runningItems.has(item.id) ? '再按會加入 Queue' : '執行'
  runBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    void runItem(item.id)
  })

  // 底部列：spinners + run button
  const bottomRow = document.createElement('div')
  bottomRow.className = 'card-bottom-row'
  bottomRow.appendChild(spinners)
  bottomRow.appendChild(runBtn)

  // 右側：齒輪按鈕
  const gearBtn = document.createElement('button')
  gearBtn.className = 'btn-gear'
  gearBtn.title = '設定'
  gearBtn.innerHTML = '⚙️'
  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    openSettingsDialog(item.id)
  })

  // 滑鼠懸停效果：顯示齒輪按鈕
  card.addEventListener('mouseenter', () => {
    gearBtn.classList.add('visible')
  })
  card.addEventListener('mouseleave', () => {
    gearBtn.classList.remove('visible')
  })

  // 點擊卡片本身 → 選取項目，顯示執行過程
  card.addEventListener('click', () => {
    selectItem(item.id)
  })

  // 組裝圖示列
  if (itemEvents.length > 0) iconsRow.appendChild(eventIcon)
  if (item.allowHttp) {
    const httpIcon = document.createElement('span')
    httpIcon.className = 'item-event-icon active'
    httpIcon.textContent = '🌐'
    httpIcon.title = '允許透過 HTTP 請求執行此 Agent 任務'
    iconsRow.appendChild(httpIcon)
  }
  const itemMappings = eventMappings.filter((m) => m.agentId === item.id)
  if (itemMappings.length > 0) {
    const mappingIcon = document.createElement('span')
    mappingIcon.className = 'item-event-icon active'
    mappingIcon.textContent = '🔗'
    mappingIcon.title = `事件訂閱：已訂閱 ${itemMappings.length} 個自訂事件（${itemMappings.map(m => m.eventId).join(', ')}）`
    iconsRow.appendChild(mappingIcon)
  }

  // 組裝卡片（順序：圖示列 → 資訊 → 底部 → 齒輪）
  card.appendChild(iconsRow)
  card.appendChild(info)
  card.appendChild(bottomRow)
  card.appendChild(gearBtn)

  return card
}

/** 建立單一項目列表列（精簡模式） */
function createItemListRow(item: ListItem): HTMLElement {
  const row = document.createElement('div')
  row.className = 'item-list-row'
  row.dataset.id = String(item.id)

  if (selectedItemId === item.id) {
    row.classList.add('selected')
  }
  if (runningItems.has(item.id)) {
    row.classList.add('has-running-agent')
  }

  const itemEvents = scheduledEvents.filter((event) => event.agentId === item.id)
  const activeEvents = itemEvents.filter((event) => event.recurrence === 'interval' || !event.executedAt)
  const eventIcon = document.createElement('span')
  if (itemEvents.length > 0) {
    eventIcon.className = `item-event-icon${activeEvents.length > 0 ? ' active' : ''}`
    eventIcon.textContent = '⏰'
    eventIcon.title = `事件：${itemEvents.length}（待執行／循環：${activeEvents.length}）`
  }

  const info = document.createElement('div')
  info.className = 'item-info'

  const nameEl = document.createElement('span')
  nameEl.className = 'item-name'
  nameEl.textContent = item.name

  const metaEl = document.createElement('span')
  metaEl.className = 'item-meta'
  metaEl.textContent = formatMeta(item)

  info.appendChild(nameEl)
  info.appendChild(metaEl)

  const spinners = document.createElement('span')
  spinners.className = 'run-spinners'
  renderSpinners(spinners, item.id)

  const runBtn = document.createElement('button')
  runBtn.className = 'btn-run'
  runBtn.innerHTML = '▶️'
  runBtn.title = runningItems.has(item.id) ? '再按會加入 Queue' : '執行'
  runBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    void runItem(item.id)
  })

  const gearBtn = document.createElement('button')
  gearBtn.className = 'btn-gear'
  gearBtn.title = '設定'
  gearBtn.innerHTML = '⚙️'
  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    openSettingsDialog(item.id)
  })

  row.addEventListener('mouseenter', () => {
    gearBtn.classList.add('visible')
  })
  row.addEventListener('mouseleave', () => {
    gearBtn.classList.remove('visible')
  })

  row.addEventListener('click', () => {
    selectItem(item.id)
  })

  if (itemEvents.length > 0) row.appendChild(eventIcon)
  if (item.allowHttp) {
    const httpIcon = document.createElement('span')
    httpIcon.className = 'item-event-icon active'
    httpIcon.textContent = '🌐'
    httpIcon.title = '允許透過 HTTP 請求執行此 Agent 任務'
    row.appendChild(httpIcon)
  }
  const itemMappings = eventMappings.filter((m) => m.agentId === item.id)
  if (itemMappings.length > 0) {
    const mappingIcon = document.createElement('span')
    mappingIcon.className = 'item-event-icon active'
    mappingIcon.textContent = '🔗'
    mappingIcon.title = `事件訂閱：已訂閱 ${itemMappings.length} 個自訂事件（${itemMappings.map(m => m.eventId).join(', ')}）`
    row.appendChild(mappingIcon)
  }
  row.appendChild(info)
  row.appendChild(spinners)
  row.appendChild(runBtn)
  row.appendChild(gearBtn)

  return row
}

/** 依 running + queue 狀態填入 N 個轉圈圈 icon（running=1 + queued=N） */
function renderSpinners(container: HTMLElement, id: number): void {
  const running = runningItems.has(id) ? 1 : 0
  const queued = itemTaskQueues.get(id)?.length ?? 0
  const total = running + queued
  container.innerHTML = ''
  container.title = ''
  for (let i = 0; i < total; i++) {
    const s = document.createElement('span')
    const isActive = i === 0 && running > 0
    s.className = isActive ? 'run-spinner active' : 'run-spinner queued'
    s.title = isActive ? '執行中' : '等待中（點擊可取消）'
    if (!isActive) {
      // 排隊 icon：可點開下拉選單取消該項
      const queueIdx = i - running  // 0-based in queue array
      s.classList.add('clickable')
      s.addEventListener('click', (e) => {
        e.stopPropagation()
        openQueueItemMenu(s, id, queueIdx)
      })
    }
    container.appendChild(s)
  }
}

/** 在指定 spinner 附近彈出「取消」下拉選單 */
function openQueueItemMenu(anchor: HTMLElement, itemId: number, queueIdx: number): void {
  // 關掉現存的任何 menu
  document.querySelectorAll('.queue-item-menu').forEach((el) => el.remove())

  const menu = document.createElement('div')
  menu.className = 'queue-item-menu'
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'queue-item-menu-btn'
  cancelBtn.textContent = '✕ 取消此任務'
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    cancelQueuedTask(itemId, queueIdx)
    menu.remove()
  })
  menu.appendChild(cancelBtn)

  // 定位：spinner 下方
  const rect = anchor.getBoundingClientRect()
  menu.style.position = 'fixed'
  menu.style.left = rect.left + 'px'
  menu.style.top = (rect.bottom + 4) + 'px'
  document.body.appendChild(menu)

  // 點 menu 以外的地方關掉
  const closeOnOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove()
      document.removeEventListener('mousedown', closeOnOutside)
    }
  }
  // 用 setTimeout 讓當前 click 事件先跑完，避免馬上被關掉
  setTimeout(() => document.addEventListener('mousedown', closeOnOutside), 0)
}

/** 從指定 item 的 queue 中移除第 idx 個任務 */
function cancelQueuedTask(itemId: number, idx: number): void {
  const queue = itemTaskQueues.get(itemId)
  if (!queue || idx < 0 || idx >= queue.length) return
  queue.splice(idx, 1)
  if (queue.length === 0) itemTaskQueues.delete(itemId)
  const logs = itemLogs.get(itemId) ?? []
  logs.push({
    level: 'system',
    message: `🚫 已取消 Queue 第 ${idx + 1} 個排隊任務（剩餘 ${queue.length} 項）`,
    timestamp: Date.now(),
  })
  itemLogs.set(itemId, logs)
  syncAgentStatus()
  // 重繪這張 card 的 spinner；也刷新 message box 讓 log 立即顯示
  const card = document.querySelector(`.item-card[data-id="${itemId}"], .item-list-row[data-id="${itemId}"]`) as HTMLElement | null
  if (card) {
    const spinners = card.querySelector('.run-spinners') as HTMLElement | null
    if (spinners) renderSpinners(spinners, itemId)
  }
  if (selectedItemId === itemId && viewingSessionData === null) renderMessageBox(itemId)
}

/** 格式化卡片下方的副資訊 */
function formatMeta(item: ListItem): string {
  const modelLabel = item.modelName || '未設定'
  const promptPreview =
    item.prompt.length > 40
      ? item.prompt.slice(0, 40) + '…'
      : item.prompt || '無 Prompt'

  return `${modelLabel} ｜ ${promptPreview}`
}

// ============================================================
// 選取與訊息框邏輯
// ============================================================

/** 選取項目，顯示其執行過程 */
function selectItem(id: number): void {
  const item = items.find((i) => i.id === id)
  if (!item) return

  // 若點擊的是同一個 item，且目前在查看歷史 session，切回即時模式
  if (selectedItemId === id && viewingSessionData !== null) {
    viewingSessionData = null
    viewingSessionPath = null
    showLiveViewInPanel(id)
    renderSessionHistoryActiveState()
    return
  }

  // 更新選中狀態
  selectedItemId = id
  viewingSessionData = null
  viewingSessionPath = null

  // 重新渲染以更新卡片 selected 樣式
  document.querySelectorAll('.item-card, .item-list-row').forEach((card) => {
    const cardId = Number((card as HTMLElement).dataset.id)
    if (cardId === id) {
      card.classList.add('selected')
    } else {
      card.classList.remove('selected')
    }
  })

  renderMessageBox(id)
  updateInputBoxState()
  void loadAndRenderSessions(item)
}

/** 呼叫指定 item 設定的模型 API */
async function runItem(id: number, parameters?: unknown, execId?: string): Promise<void> {
  const item = items.find((i) => i.id === id)
  if (!item) return

  // 同一個 item 一次只執行一項任務，其餘依到達順序排隊
  if (runningItems.has(id)) {
    if (!itemLogs.has(id)) itemLogs.set(id, [])
    const queueLogs = itemLogs.get(id)!
    const queue = itemTaskQueues.get(id) ?? []
    if (queue.length >= MAX_QUEUED_TASKS_PER_ITEM) {
      queueLogs.push({ level: 'error', message: `Queue 已達上限 ${MAX_QUEUED_TASKS_PER_ITEM}，拒絕新任務`, timestamp: Date.now() })
    } else {
      queue.push({ parameters, enqueuedAt: Date.now(), execId })
      itemTaskQueues.set(id, queue)
      syncAgentStatus()
      queueLogs.push({
        level: 'info',
        message: `新任務已加入 Queue，排隊順位：${queue.length}${parameters !== undefined ? `\n參數：${JSON.stringify(parameters)}` : ''}`,
        timestamp: Date.now(),
      })
      updateCardRunButton(id, true)
    }
    if (selectedItemId === id && viewingSessionData === null) renderMessageBox(id)
    return
  }

  // 開始新 session：清除 UI log 與 exchanges，確保每次 run 都是乾淨的開始
  itemLogs.set(id, [])
  currentSessionExchanges.set(id, [])
  const logs = itemLogs.get(id)!
  currentSessionStartedAt.set(id, Date.now())
  startLiveSession(item)

  // 若此 item 正在查看歷史 session，自動切回即時模式
  if (selectedItemId === id && viewingSessionData !== null) {
    viewingSessionData = null
    viewingSessionPath = null
    renderSessionHistoryActiveState()
  }

  if (parameters !== undefined) {
    let sourceMsg = `HTTP 輸入參數：${JSON.stringify(parameters)}`
    if (parameters && typeof parameters === 'object' && '_triggerSource' in parameters) {
      const p = parameters as any
      if (p._triggerSource === 'event') {
        sourceMsg = `事件「${p.eventId}」觸發執行`
        const details = []
        if (p.message) details.push(`message: "${p.message}"`)
        if (p.arg1) details.push(`arg1: "${p.arg1}"`)
        if (p.arg2) details.push(`arg2: "${p.arg2}"`)
        if (p.arg3) details.push(`arg3: "${p.arg3}"`)
        if (details.length > 0) {
          sourceMsg += `，參數：${details.join(', ')}`
        }
      }
    }
    logs.push({
      level: 'info',
      message: sourceMsg,
      timestamp: Date.now(),
    })
  }

  const resolvedPrompt = resolvePromptArguments(item.prompt, parameters)

  // 寫入啟動訊息
  const now = Date.now()
  logs.push({ level: 'system', message: `══════ Agent「${item.name}」開始執行 ══════`, timestamp: now })
  logs.push({ level: 'info', message: `模型：${item.modelName || '未設定'} ｜ 端點：${item.apiBaseUrl || '未設定'}`, timestamp: now + 1 })

  if (parameters !== undefined) {
    if (resolvedPrompt.trim()) {
      logs.push({ level: 'system', message: `發送給 AI 模型的 System Prompt：\n${resolvedPrompt}`, timestamp: now + 2 })
    }
    const modelInput = typeof parameters === 'string'
      ? parameters
      : JSON.stringify(parameters, null, 2)
    logs.push({ level: 'system', message: `發送給 AI 模型的輸入：\n${modelInput}`, timestamp: now + 3 })
  } else {
    logs.push({
      level: resolvedPrompt.trim() ? 'system' : 'warn',
      message: `發送給 AI 模型的 Prompt：\n${resolvedPrompt || '（空白）'}`,
      timestamp: now + 2,
    })
  }
  if (item.tools.length > 0) {
    logs.push({
      level: 'info',
      message: `已啟用工具：${item.tools.join(', ')}\n工作目錄：${item.workingDirectory || 'App 工作目錄'}`,
      timestamp: now + 4,
    })
  }
  if (item.skills.length > 0) {
    logs.push({
      level: 'info',
      message: `已載入 Skills：${item.skills.join(', ')}`,
      timestamp: now + 5,
    })
  }
  const enabledMcp = item.mcpServers.filter((s) => s.enabled)
  if (enabledMcp.length > 0) {
    logs.push({
      level: 'info',
      message: `MCP Servers：${enabledMcp.map((s) => `${s.name} (${s.transport})`).join(', ')}`,
      timestamp: now + 6,
    })
  }
  if (item.memory) {
    logs.push({
      level: 'info',
      message: '記憶功能：開啟（自動攜帶上次對話歷史）',
      timestamp: now + 7,
    })
  }
  scheduleLiveSessionFlush(item, 100)

  // 若目前選取的是此 item 且在即時模式，立即更新訊息框
  if (selectedItemId === id && viewingSessionData === null) {
    renderMessageBox(id)
  }

  runningItems.add(id)
  updateInputBoxState()
  if (execId) currentExecIdByItem.set(id, execId)
  else currentExecIdByItem.delete(id)
  syncAgentStatus()
  updateCardRunButton(id, true)

  // 追蹤此次執行結果，供 finally 建立 lastTaskByAgent 條目使用
  let taskSuccess = false
  let taskContent = ''

  try {
    const result = await invoke<AgentExecutionResult>('execute_agent', {
      request: {
        itemId: item.id,
        apiBaseUrl: item.apiBaseUrl,
        apiKey: item.apiKey,
        modelName: item.modelName,
        prompt: resolvedPrompt,
        parameters,
        workingDirectory: item.workingDirectory,
        tools: item.tools,
        skills: item.skills,
        mcpServers: item.mcpServers,
        selectedMcpTools: item.mcpTools,
        memory: item.memory,
        itemCode: item.code,
        toolsSearch: item.toolsSearch,
        embeddingApiBaseUrl: globalEmbeddingApiBaseUrl,
        embeddingApiKey: globalEmbeddingApiKey,
        embeddingModel: globalEmbeddingModel,
      },
    })
    logs.push({ level: 'success', message: `模型端點：${result.endpoint}`, timestamp: Date.now() })
    logs.push({ level: 'system', message: result.content, html: renderMarkdownSafe(result.content), timestamp: Date.now() + 1 })
    taskSuccess = true
    taskContent = result.content ?? ''
  } catch (error) {
    logs.push({ level: 'error', message: `模型請求失敗：${String(error)}`, timestamp: Date.now() })
    taskSuccess = false
    taskContent = String(error)
  } finally {
    // 統整 token 用量（總計），在結束分隔線之前顯示
    const summary = summarizeSessionTokens(id)
    if (summary.rounds.length > 0) {
      const lines = ['執行任務效率 :']
      lines.push(`  📊 Token 用量統計：${formatUsage(summary.total)}`)
      // 顯示 cached_tokens 占 prompt 的比例
      const cached = summary.total.cachedTokens
      const prompt = summary.total.prompt
      if (cached !== undefined && prompt > 0) {
        const pct = (cached / prompt * 100).toFixed(1)
        lines.push(`  Cache 命中率：${cached} / ${prompt} = ${pct}%`)
      }
      lines.push(`  執行輪數：${summary.rounds.length}`)
      const startedAt = currentSessionStartedAt.get(id)
      const durationMs = startedAt ? (Date.now() - startedAt) : 0
      const durationSec = (durationMs / 1000).toFixed(1)
      lines.push(`  Total執行時間：${durationSec} 秒`)
      logs.push({ level: 'info', message: lines.join('\n'), timestamp: Date.now() })
    }
    logs.push({ level: 'system', message: `══════ Agent「${item.name}」執行結束 ══════`, timestamp: Date.now() + 1 })
    runningItems.delete(id)
    updateInputBoxState()
    // 記錄此次任務結果（下次 sync 會帶到 lastEndedAt / lastSuccess / lastTokens…）
    const finishedExecId = currentExecIdByItem.get(id)
    currentExecIdByItem.delete(id)
    lastTaskByAgent.set(item.name, {
      lastEndedAt: Date.now(),
      lastSuccess: taskSuccess,
      lastContentPreview: taskContent.length > 200 ? taskContent.slice(0, 200) + '…' : taskContent,
      lastTokens: summary.total.total,
      lastRounds: summary.rounds.length,
      lastExecId: finishedExecId,
      lastPromptTokens: summary.total.prompt,
      lastCachedTokens: summary.total.cachedTokens,
    })
    const queue = itemTaskQueues.get(id)
    const nextTask = queue?.shift()
    if (queue && queue.length === 0) itemTaskQueues.delete(id)
    // 立即同步狀態到 Rust，讓 HTTP action=get_status 能查到最新狀態。
    // 這行放在後面的 UI 更新/saveSession 之前，避免那些操作意外拋錯導致狀態未同步。
    syncAgentStatus()
    updateCardRunButton(id, false)
    if (selectedItemId === id && viewingSessionData === null) renderMessageBox(id)

    // 儲存本次 session，並把路徑補進 lastTaskByAgent，讓 status 能提供 session link
    void saveCurrentSession(item).then((savedPath) => {
      if (savedPath) {
        const info = lastTaskByAgent.get(item.name) ?? {}
        info.lastSessionPath = savedPath
        info.lastSessionUrl = `http://127.0.0.1:37123/session_file?path=${encodeURIComponent(savedPath)}`
        lastTaskByAgent.set(item.name, info)
        syncAgentStatus()  // 再同步一次，讓 status 帶到 sessionPath / sessionUrl
      }
    })
    if (nextTask) {
      logs.push({
        level: 'system',
        message: `從 Queue 取出下一項任務（已等待 ${Math.max(0, Math.round((Date.now() - nextTask.enqueuedAt) / 1000))} 秒，剩餘 ${queue?.length ?? 0} 項）`,
        timestamp: Date.now(),
      })
      if (selectedItemId === id && viewingSessionData === null) renderMessageBox(id)
      void runItem(id, nextTask.parameters, nextTask.execId)
    }
  }
}

/** 取出 HTTP server 收到的輸入，依項目名稱分派 */
async function drainHttpInputs(): Promise<void> {
  if (!isTauri()) return

  try {
    const pending = await invoke<HttpInput[]>('take_http_inputs')
    pending.forEach((input) => {
      // 優先用穩定 agentId 找項目；若沒帶就退回用名字比對（backward compat）
      const item = (input.agentId && items.find((c) => c.agentId === input.agentId))
        || items.find((c) => itemNameKey(c.name) === itemNameKey(input.agent))
      if (!item) {
        console.warn(`找不到 agentId「${input.agentId ?? ''}」或名稱「${input.agent}」的項目`)
        return
      }
      if (!item.allowHttp) {
        console.warn(`項目「${item.name}」未啟用 HTTP 接收功能`)
        return
      }
      void runItem(item.id, input.parameters, input.execId)
    })
  } catch (error) {
    console.error('讀取 HTTP 輸入失敗', error)
  }
}

/** 更新卡片上的執行狀態 */
function updateCardRunButton(id: number, running: boolean): void {
  const card = document.querySelector(`.item-card[data-id="${id}"], .item-list-row[data-id="${id}"]`) as HTMLElement | null
  if (!card) return

  const spinners = card.querySelector('.run-spinners') as HTMLElement | null
  if (spinners) renderSpinners(spinners, id)

  const btn = card.querySelector('.btn-run') as HTMLButtonElement | null
  if (!btn) return

  // 按鈕本身不再變沙漏／禁用，僅更新 tooltip 與 card class
  btn.innerHTML = '▶️'
  btn.title = running ? '再按會加入 Queue' : '執行'
  if (running) {
    card.classList.add('has-running-agent')
  } else {
    card.classList.remove('has-running-agent')
  }
}

/** 渲染訊息框內容（即時執行過程） */
function renderMessageBox(itemId: number | null): void {
  const item = itemId !== null ? items.find((i) => i.id === itemId) : null
  if (!item) {
    msgContent.innerHTML = '<span class="message-placeholder">← 點擊任一項目以查看執行過程</span>'
    msgItemName.textContent = ''
    msgPanelTitle.textContent = '📋 執行過程'
    return
  }

  msgPanelTitle.textContent = '📋 執行過程'
  msgItemName.textContent = item.name

  const logs = itemLogs.get(item.id)
  if (!logs || logs.length === 0) {
    msgContent.innerHTML = '<span class="message-placeholder">尚無執行記錄</span>'
    return
  }

  msgContent.innerHTML = logsToHtml(logs)

  // 自動捲到最底部
  msgContent.scrollTop = msgContent.scrollHeight
}

/** 更新底部的使用者訊息輸入框狀態 */
function updateInputBoxState(): void {
  if (!agentUserInput || !btnSendMessage) return

  if (selectedItemId === null) {
    agentUserInput.disabled = true
    agentUserInput.placeholder = '請先選取項目'
    btnSendMessage.disabled = true
  } else {
    const item = items.find((i) => i.id === selectedItemId)
    const isRunning = runningItems.has(selectedItemId)

    agentUserInput.disabled = false
    btnSendMessage.disabled = false
    if (isRunning) {
      agentUserInput.placeholder = `對執行中的 Agent「${item?.name ?? ''}」插話...`
    } else {
      agentUserInput.placeholder = `輸入訊息給 Agent「${item?.name ?? ''}」...`
    }
  }
}


/** 更新切換按鈕的視覺狀態 */
function updateViewToggleUI(): void {
  btnViewToggle.textContent = viewDetailed ? '詳細' : '簡化'
}

/** 更新列表檢視切換按鈕的視覺狀態 */
function updateListViewToggleUI(): void {
  if (listViewMode === 'list') {
    btnListViewToggle.textContent = '🫧'
    btnListViewToggle.classList.add('active')
    btnListViewToggle.title = '切換為卡片顯示'
  } else {
    btnListViewToggle.textContent = '🫧'
    btnListViewToggle.classList.remove('active')
    btnListViewToggle.title = '切換為列表顯示'
  }
}

const SIMPLE_TRUNCATE_LIMIT = 600

function truncateForSimple(text: string): string {
  if (text.length <= SIMPLE_TRUNCATE_LIMIT) return text
  return text.slice(0, SIMPLE_TRUNCATE_LIMIT) + `\n…（已截斷，共 ${text.length} 字）`
}

function commandOutputKey(payload: unknown): string {
  const p = payload as Record<string, unknown>
  return String(p.callId || `${p.command || 'command'}:${JSON.stringify(p.args || [])}`)
}

function commandOutputTitle(payload: unknown): string {
  const p = payload as Record<string, unknown>
  const command = String(p.command || 'command')
  const args = Array.isArray(p.args) ? p.args.map(String) : []
  const cwd = String(p.cwd || '')
  return `${command}${args.length ? ' ' + args.join(' ') : ''}${cwd ? `  (${cwd})` : ''}`
}

function renderCommandOutputHtml(key: string, title: string, lines: string[]): string {
  const domKey = escapeHtml(commandOutputDomKey(key))
  return (
    `<div class="command-output-box" data-command-output-key="${domKey}">` +
    `<div class="command-output-title">${escapeHtml(title)}</div>` +
    `<div class="command-output-body">${renderCommandOutputBodyHtml(lines)}</div>` +
    `</div>`
  )
}

function renderCommandOutputBodyHtml(lines: string[]): string {
  const visible = lines.slice(-10)
  const body = visible.length > 0
    ? visible.map((line) => `<div>${escapeHtml(line)}</div>`).join('')
    : '<div class="command-output-muted">（尚無輸出）</div>'
  const omitted = lines.length > 10
    ? `<div class="command-output-muted">… 只顯示最新 10 行（已省略 ${lines.length - 10} 行）</div>`
    : ''
  return omitted + body
}

function commandOutputDomKey(key: string): string {
  return `cmd-${Array.from(key).map((ch) => ch.charCodeAt(0).toString(16)).join('-')}`
}

function upsertCommandOutputLog(logs: LogEntry[], payload: unknown, timestamp: number): LogEntry {
  const p = payload as Record<string, unknown>
  const key = commandOutputKey(payload)
  const payloadLines = Array.isArray(p.lines)
    ? p.lines.map((item) => {
        const lineItem = item as Record<string, unknown>
        return {
          stream: String(lineItem.stream || 'stdout'),
          line: String(lineItem.line ?? ''),
        }
      })
    : [{ stream: String(p.stream || 'stdout'), line: String(p.line ?? '') }]
  let entry = logs.find((candidate) => candidate.commandOutputKey === key)
  if (!entry) {
    entry = {
      level: 'system',
      message: '',
      timestamp,
      commandOutputKey: key,
      commandOutputLines: [],
      commandOutputTitle: commandOutputTitle(payload),
    }
    logs.push(entry)
  }
  payloadLines.forEach(({ stream, line }) => {
    const prefix = stream === 'system' ? '' : `[${stream}] `
    entry!.commandOutputLines!.push(`${prefix}${line}`)
  })
  entry.timestamp = timestamp
  entry.message = `${entry.commandOutputTitle}\n${entry.commandOutputLines!.join('\n')}`
  entry.html = renderCommandOutputHtml(entry.commandOutputKey!, entry.commandOutputTitle!, entry.commandOutputLines!)
  return entry
}

function updateLiveCommandOutputBox(entry: LogEntry): boolean {
  if (!entry.commandOutputKey || !entry.commandOutputLines) return false
  const key = commandOutputDomKey(entry.commandOutputKey)
  const box = msgContent.querySelector<HTMLElement>(`.command-output-box[data-command-output-key="${key}"]`)
  const body = box?.querySelector<HTMLElement>('.command-output-body')
  if (!box || !body) return false
  body.innerHTML = renderCommandOutputBodyHtml(entry.commandOutputLines)
  msgContent.scrollTop = msgContent.scrollHeight
  return true
}

interface UsageSummary {
  prompt: number
  completion: number
  total: number
  cacheHit?: number       // prompt_cache_hit_tokens
  cacheMiss?: number      // prompt_cache_miss_tokens
  cachedTokens?: number   // prompt_tokens_details.cached_tokens
  reasoning?: number      // completion_tokens_details.reasoning_tokens
}

function extractUsage(payload: unknown): UsageSummary | null {
  const usage = (payload as any)?.body?.usage as Record<string, unknown> | undefined
  if (!usage) return null
  const prompt = (usage.prompt_tokens as number) ?? 0
  const completion = (usage.completion_tokens as number) ?? 0
  const total = (usage.total_tokens as number) ?? (prompt + completion)
  if (prompt === 0 && completion === 0 && total === 0) return null
  const cacheHit = usage.prompt_cache_hit_tokens as number | undefined
  const cacheMiss = usage.prompt_cache_miss_tokens as number | undefined
  const cachedTokens = (usage.prompt_tokens_details as any)?.cached_tokens as number | undefined
  const reasoning = (usage.completion_tokens_details as any)?.reasoning_tokens as number | undefined
  return { prompt, completion, total, cacheHit, cacheMiss, cachedTokens, reasoning }
}

function formatUsage(u: UsageSummary): string {
  // prompt 的細節：cache hit / miss / cached_tokens
  const promptExtras: string[] = []
  if (u.cacheHit !== undefined) promptExtras.push(`cache hit ${u.cacheHit}`)
  if (u.cacheMiss !== undefined) promptExtras.push(`cache miss ${u.cacheMiss}`)
  if (u.cachedTokens !== undefined) promptExtras.push(`cached_tokens ${u.cachedTokens}`)
  const promptStr = promptExtras.length
    ? `prompt ${u.prompt} (${promptExtras.join(', ')})`
    : `prompt ${u.prompt}`
  // completion 的細節：reasoning
  const completionStr = u.reasoning !== undefined
    ? `completion ${u.completion} (reasoning ${u.reasoning})`
    : `completion ${u.completion}`
  return `${promptStr} + ${completionStr} = ${u.total}`
}

function summarizeSessionTokens(itemId: number): { rounds: { round: number, usage: UsageSummary }[], total: UsageSummary } {
  const exchanges = currentSessionExchanges.get(itemId) ?? []
  const rounds: { round: number, usage: UsageSummary }[] = []
  let prompt = 0, completion = 0, total = 0
  let cacheHit = 0, cacheMiss = 0, cachedTokens = 0, reasoning = 0
  let hasCacheHit = false, hasCacheMiss = false, hasCachedTokens = false, hasReasoning = false
  exchanges.forEach((ex) => {
    if (ex.phase !== 'response') return
    const u = extractUsage(ex.payload)
    if (!u) return
    rounds.push({ round: ex.round, usage: u })
    prompt += u.prompt
    completion += u.completion
    total += u.total
    if (u.cacheHit !== undefined) { cacheHit += u.cacheHit; hasCacheHit = true }
    if (u.cacheMiss !== undefined) { cacheMiss += u.cacheMiss; hasCacheMiss = true }
    if (u.cachedTokens !== undefined) { cachedTokens += u.cachedTokens; hasCachedTokens = true }
    if (u.reasoning !== undefined) { reasoning += u.reasoning; hasReasoning = true }
  })
  return {
    rounds,
    total: {
      prompt, completion, total,
      cacheHit: hasCacheHit ? cacheHit : undefined,
      cacheMiss: hasCacheMiss ? cacheMiss : undefined,
      cachedTokens: hasCachedTokens ? cachedTokens : undefined,
      reasoning: hasReasoning ? reasoning : undefined,
    },
  }
}

/** 把 log 條目轉為 HTML，簡化模式下只顯示可讀摘要，詳細模式下只顯示原始 JSON */
function logsToHtml(logs: LogEntry[]): string {
  return logs
    .filter((entry) => {
      if (entry.kind === 'detail') return viewDetailed
      if (entry.kind === 'simple') return !viewDetailed
      return true
    })
    .map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString('zh-TW', { hour12: false })
      let body: string
      if (entry.html) {
        body = entry.html
      } else {
        const message = viewDetailed ? entry.message : truncateForSimple(entry.message)
        body = escapeHtml(message)
      }
      return `<div class="log-line log-${entry.level}">[${time}] ${body}</div>`
    })
    .join('')
}

/** 輕量 markdown → HTML：處理標題、粗體、分隔線、表格。用於 AI 回覆的簡化模式渲染。 */
function renderMarkdownSafe(input: string, borderStyle?: TableBorderStyle): string {
  const lines = input.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 表格：目前行是 |...|，下一行是 |---|---|
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const header = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      const bs = borderStyle ?? defaultTableBorderStyle
      const styleAttr = borderStyleToStyleAttr(bs)
      const mergeEnabled = bs.mergeCells === true
      out.push(`<table class="md-table"${styleAttr}>`)
      // 表頭也處理合併（僅 colspan，表頭不支援 ^^ rowspan）
      const headerCells = mergeEnabled ? processRowColspan(header) : header.map((c) => ({ text: c, colspan: 1, rowspan: 1 }))
      out.push('<thead><tr>' + headerCells.map((c) => {
        const spanAttr = buildSpanAttr(c.colspan, c.rowspan)
        return `<th${spanAttr}>${renderInline(c.text)}</th>`
      }).join('') + '</tr></thead>')
      // 處理資料列
      const mergedRows = mergeEnabled ? processTableRows(rows, headerCells) : rows.map((r) => r.map((c) => ({ text: c, colspan: 1, rowspan: 1 })))
      out.push('<tbody>' + mergedRows.map((row) => {
        return '<tr>' + row.map((c) => {
          const spanAttr = buildSpanAttr(c.colspan, c.rowspan)
          return `<td${spanAttr}>${renderInline(c.text)}</td>`
        }).join('') + '</tr>'
      }).join('') + '</tbody>')
      out.push('</table>')
      continue
    }
    // 標題 ## / ### / ####
    const heading = /^(#{2,4})\s+(.+)$/.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1].length + 1) // ## → h3, ### → h4
      out.push(`<h${level} class="md-heading">${renderInline(heading[2])}</h${level}>`)
      i++
      continue
    }
    // 水平分隔線
    if (/^\s*(---|===|\*\*\*)\s*$/.test(line)) {
      out.push('<hr class="md-hr">')
      i++
      continue
    }
    // 一般行
    out.push(`<div>${renderInline(line)}</div>`)
    i++
  }
  return out.join('')
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

// ============================================================
// 表格合併儲存格（框線與合併功能）
// ============================================================

/** 儲存格跨度資訊 */
interface TableCellSpan {
  text: string
  colspan: number
  rowspan: number
}

/** 產生 colspan / rowspan 屬性字串 */
function buildSpanAttr(colspan: number, rowspan: number): string {
  const parts: string[] = []
  if (colspan > 1) parts.push(`colspan="${colspan}"`)
  if (rowspan > 1) parts.push(`rowspan="${rowspan}"`)
  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

/**
 * 合併標記語法（僅在 mergeCells=true 時啟用）：
 * - 「>」 整格內容 = 向右合併至左方格（colspan +1）
 * - 「^^」 整格內容 = 向上合併至上方格（rowspan +1）
 * - 「>^^」或「^^>」 = 同時向右與向上合併
 * - 可連續多個 > 來合併多欄。
 * 注意：合併標記必須是「整格唯一內容」，不能與文字混合。
 */

/** 處理單列的 colspan 合併（向右合併 >） */
function processRowColspan(cells: string[]): TableCellSpan[] {
  const result: TableCellSpan[] = []
  for (const raw of cells) {
    if (isMergeMarker(raw)) {
      // 純合併標記：加到前一格的 colspan
      if (result.length > 0 && isRightMerge(raw)) {
        result[result.length - 1].colspan++
      } else {
        // ^^ 或 ^^>（只有向上合併、沒有向右）— 仍要佔一個欄位位置
        result.push({ text: '', colspan: 1, rowspan: 1 })
      }
      continue
    }
    result.push({ text: raw.trim(), colspan: 1, rowspan: 1 })
  }
  return result
}

/** 判斷整格是否為純合併標記 */
function isMergeMarker(cell: string): boolean {
  const t = cell.trim()
  return t === '>' || t === '^^' || t === '>^^' || t === '^^>'
}

/** 合併標記是否包含向右合併（>） */
function isRightMerge(cell: string): boolean {
  const t = cell.trim()
  return t === '>' || t === '>^^' || t === '^^>'
}

/** 合併標記是否包含向上合併（^^） */
function isUpMerge(cell: string): boolean {
  const t = cell.trim()
  return t === '^^' || t === '>^^' || t === '^^>'
}

/** 處理所有資料列的 colspan / rowspan */
function processTableRows(rows: string[][], headerCells: TableCellSpan[]): TableCellSpan[][] {
  // 計算總欄數（從表頭的 colspan 得出）
  const totalCols = headerCells.reduce((sum, c) => sum + c.colspan, 0)

  // rowspanState[col] = 尚需跳過的剩餘 rowspan 層數
  const rowspanState: number[] = new Array(totalCols).fill(0)

  const result: TableCellSpan[][] = []

  for (const row of rows) {
    const outRow: TableCellSpan[] = []
    let colIdx = 0 // 實際欄位索引（考慮 rowspan）
    let cellIdx = 0 // 原始輸入格索引

    while (colIdx < totalCols && cellIdx < row.length) {
      // 跳過被上方 rowspan 佔用的欄位
      if (rowspanState[colIdx] > 0) {
        rowspanState[colIdx]--
        colIdx++
        continue
      }

      const raw = row[cellIdx]
      cellIdx++

      // 純合併標記：整格被合併
      if (isMergeMarker(raw)) {
        const right = isRightMerge(raw)
        const up = isUpMerge(raw)

        // 向上合併：遞增上方對應格的 rowspan，此格不輸出
        if (up && result.length > 0) {
          const aboveCell = findCellAtCol(result[result.length - 1], colIdx)
          if (aboveCell) {
            aboveCell.rowspan++
          }
        }
        // 向右合併：遞增左方格的 colspan
        if (right && outRow.length > 0) {
          outRow[outRow.length - 1].colspan++
          colIdx++ // 此欄已被合併，佔用一個 col 位置
        }
        // 只有向上沒有向右：仍需佔一個欄位（已被上方 rowspan 覆蓋的概念）
        // 實際上不會到這裡，因為若只有 ^^，colIdx 位置的 rowspanState 會 > 0
        continue
      }

      // 一般內容格
      const cell: TableCellSpan = { text: raw.trim(), colspan: 1, rowspan: 1 }
      outRow.push(cell)
      colIdx++
    }

    result.push(outRow)

    // 從 outRow 推算新的 rowspanState（供下一列使用）
    updateRowspanState(rowspanState, outRow, totalCols)
  }

  return result
}

/** 找出列中位於指定 col 索引的儲存格 */
function findCellAtCol(row: TableCellSpan[], targetCol: number): TableCellSpan | null {
  let c = 0
  for (const cell of row) {
    if (c === targetCol) return cell
    c += cell.colspan
  }
  return null
}

/** 根據本列輸出更新 rowspanState */
function updateRowspanState(state: number[], row: TableCellSpan[], totalCols: number): void {
  // 注意：colIdx 已在 processTableRows 的 while 迴圈中對被跳過的欄位做了遞減
  // 此處只標記本列中 rowspan > 1 的格所影響的欄位（供下一列使用）
  let colIdx = 0
  for (const cell of row) {
    if (cell.rowspan > 1) {
      // 下一列開始要跳過此欄 (j=1)，再下一列 (j=2)，...
      for (let j = 1; j < cell.rowspan; j++) {
        if (colIdx < totalCols) {
          state[colIdx] = Math.max(state[colIdx], j)
        }
      }
    }
    colIdx += cell.colspan
  }
}

/** inline 元素：粗體 **x**、斜體 *x*、行內程式碼 `x`。輸入會做 HTML escape。 */
function renderInline(text: string): string {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  return s
}

function extractReasoningText(message: Record<string, unknown> | undefined): string {
  const reasoning = message?.reasoning_content ?? message?.reasoning
  if (typeof reasoning === 'string') return reasoning.trim()
  if (Array.isArray(reasoning)) {
    return reasoning
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>
          return String(p.text ?? p.content ?? '')
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

/** 從 exchange 產生簡化模式的可讀摘要 LogEntry（request 相不需要，回傳 null） */
function makeSimpleExchangeEntry(
  phase: string,
  _round: number,
  payload: unknown,
  timestamp: number,
): LogEntry | null {
  const p = payload as Record<string, unknown>
  switch (phase) {
    case 'response': {
      const body = (p.body as Record<string, unknown>) ?? {}
      const choices = (body.choices as unknown[]) ?? []
      const msg = (choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
      const content = (msg?.content as string | null | undefined) ?? ''
      const reasoning = extractReasoningText(msg)
      const toolCalls = msg?.tool_calls as unknown[] | undefined
      const reasoningText = reasoning ? `🧠 AI 決策理由：\n${reasoning}\n\n` : ''
      const reasoningHtml = reasoning ? `🧠 AI 決策理由：${renderMarkdownSafe(reasoning)}<br><br>` : ''
      let text: string
      if (toolCalls && toolCalls.length > 0) {
        const names = toolCalls
          .map((tc) => ((tc as Record<string, unknown>)?.function as Record<string, unknown> | undefined)?.name ?? '?')
          .join(', ')
        text = `${reasoningText}🤖 AI 決定呼叫工具：${names}`
        const html = `${reasoningHtml}🤖 AI 決定呼叫工具：${escapeHtml(names)}`
        return { level: 'success', message: text, html, timestamp, kind: 'simple' }
      } else if (content.trim()) {
        text = `${reasoningText}🤖 AI 回覆：\n${content}`
        const html = `${reasoningHtml}🤖 AI 回覆：${renderMarkdownSafe(content)}`
        return { level: 'success', message: text, html, timestamp, kind: 'simple' }
      } else if (reasoning) {
        return {
          level: 'success',
          message: `🧠 AI 決策理由：\n${reasoning}`,
          html: `🧠 AI 決策理由：${renderMarkdownSafe(reasoning)}`,
          timestamp,
          kind: 'simple',
        }
      } else {
        return null
      }
    }
    case 'tool': {
      const name = (p.name as string) ?? '?'
      const result = (p.result as string) ?? ''
      const args = p.arguments as Record<string, unknown> | undefined
      const filePath = args?.path as string | undefined
      const label = filePath ? `🔧 工具 ${name} [${filePath}]` : `🔧 工具 ${name}`
      return { level: 'system', message: `${label}\n${result}`, timestamp, kind: 'simple' }
    }
    case 'user_input': {
      const content = (p.content as string) ?? ''
      return { level: 'info', message: `💬 使用者插話：\n${content}`, timestamp, kind: 'simple' }
    }
    case 'error': {
      const message = (p.message as string) ?? String(payload)
      return { level: 'error', message: `✖ AI 模型錯誤：${message}`, timestamp, kind: 'simple' }
    }
    case 'vector_search': {
      const sub = p.phase as string | undefined
      if (sub === 'start') {
        return {
          level: 'system',
          message: `🔍 向量搜尋 tools 開始：model=${p.model}，候選 ${p.candidate_count} 個 tools`,
          timestamp,
          kind: 'simple',
        }
      }
      if (sub === 'result') {
        const unlocked = (p.unlocked as Array<Record<string, unknown>>) ?? []
        const ranking = (p.ranking as Array<Record<string, unknown>>) ?? []
        const topLines = unlocked.map((u) => {
          const flag = u.already_unlocked ? '（已解鎖）' : '（新解鎖）'
          return `    ✓ ${u.name}  score=${Number(u.score).toFixed(3)} ${flag}`
        }).join('\n')
        const restLines = ranking.slice(unlocked.length, unlocked.length + 4).map((r) =>
          `    · ${r.name}  score=${Number(r.score).toFixed(3)}`
        ).join('\n')
        const restBlock = restLines ? `\n  其餘排名（未解鎖）：\n${restLines}` : ''
        return {
          level: 'system',
          message: `🔍 向量搜尋 tools 完成（維度 ${p.embedding_dim}）：\n  Top-${p.top_k} 已進 tools[]：\n${topLines}${restBlock}`,
          timestamp,
          kind: 'simple',
        }
      }
      if (sub === 'error') {
        return {
          level: 'error',
          message: `🔍 向量搜尋 tools 失敗（略過，退回原本 tools_search 模式）：${p.error}`,
          timestamp,
          kind: 'simple',
        }
      }
      return null
    }
    default:
      return null
  }
}

/** HTML 跳脫 */
function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// ============================================================
// Session 儲存與歷史
// ============================================================

/** 格式化日期時間為 yyyyMMdd_HHmmss_SSS */
function formatSessionTimestamp(date: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const pad3 = (n: number) => String(n).padStart(3, '0')
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}_${pad3(date.getMilliseconds())}`
}

function sessionSavedPath(item: ListItem, sessionId: string): string {
  return item.workingDirectory
    ? `${item.workingDirectory}\\.ListAgent\\session\\${sessionId}.json`
    : `~/.listagent/sessions/${item.code}/${sessionId}.json`
}

function ensureLiveSessionMeta(item: ListItem): { sessionId: string, filename: string, savedPath: string } {
  let sessionId = currentSessionIds.get(item.id)
  if (!sessionId) {
    const startedAt = currentSessionStartedAt.get(item.id) ?? Date.now()
    sessionId = `session_${formatSessionTimestamp(new Date(startedAt))}`
    currentSessionIds.set(item.id, sessionId)
    currentSessionFilenames.set(item.id, `${sessionId}.json`)
    currentSessionSavedPaths.set(item.id, sessionSavedPath(item, sessionId))
  }
  return {
    sessionId,
    filename: currentSessionFilenames.get(item.id) ?? `${sessionId}.json`,
    savedPath: currentSessionSavedPaths.get(item.id) ?? sessionSavedPath(item, sessionId),
  }
}

function buildSessionSnapshot(item: ListItem, endedAt?: number): SessionData {
  const { sessionId } = ensureLiveSessionMeta(item)
  const startedAt = currentSessionStartedAt.get(item.id) ?? Date.now()
  const session: SessionData = {
    sessionId,
    startedAt,
    itemId: item.id,
    itemName: item.name,
    modelName: item.modelName,
    apiBaseUrl: item.apiBaseUrl,
    logs: itemLogs.get(item.id) ?? [],
    exchanges: currentSessionExchanges.get(item.id) ?? [],
  }
  if (endedAt !== undefined) session.endedAt = endedAt
  return session
}

function startLiveSession(item: ListItem): void {
  const oldTimer = currentSessionFlushTimers.get(item.id)
  if (oldTimer !== undefined) window.clearTimeout(oldTimer)
  currentSessionFlushTimers.delete(item.id)
  currentSessionIds.delete(item.id)
  currentSessionFilenames.delete(item.id)
  currentSessionSavedPaths.delete(item.id)
  ensureLiveSessionMeta(item)
  void flushLiveSessionNow(item)
}

function scheduleLiveSessionFlush(item: ListItem, delayMs: number): void {
  if (!isTauri()) return
  if (!currentSessionIds.has(item.id)) ensureLiveSessionMeta(item)
  if (currentSessionFlushTimers.has(item.id)) return
  const timer = window.setTimeout(() => {
    currentSessionFlushTimers.delete(item.id)
    void flushLiveSessionNow(item)
  }, delayMs)
  currentSessionFlushTimers.set(item.id, timer)
}

async function flushLiveSessionNow(item: ListItem, endedAt?: number): Promise<string | null> {
  if (!isTauri()) return null
  const timer = currentSessionFlushTimers.get(item.id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    currentSessionFlushTimers.delete(item.id)
  }
  const meta = ensureLiveSessionMeta(item)
  const session = buildSessionSnapshot(item, endedAt)
  const previous = currentSessionWriteChains.get(item.id) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(async () => {
    await invoke('save_session', {
      workingDirectory: item.workingDirectory,
      subdir: item.code,
      filename: meta.filename,
      content: session,
    })
  })
  currentSessionWriteChains.set(item.id, write)
  try {
    await write
    return meta.savedPath
  } catch (error) {
    console.error('即時儲存 session 失敗', error)
    return null
  }
}

/** 儲存本次執行的 session 到檔案 */
async function saveCurrentSession(item: ListItem): Promise<string | null> {
  if (!isTauri()) return null
  const logs = itemLogs.get(item.id) ?? []
  const endedAt = Date.now()
  const meta = ensureLiveSessionMeta(item)

  try {
    const savedPath = await flushLiveSessionNow(item, endedAt)
    if (!savedPath) throw new Error('即時 session 寫入失敗')
    logs.push({
      level: 'info',
      message: `💾 Session 已儲存：${meta.savedPath}`,
      timestamp: Date.now(),
    })
    await flushLiveSessionNow(item, endedAt)

    // 若目前選取的是此 item，刷新歷史清單
    if (selectedItemId === item.id) {
      await loadAndRenderSessions(item)
    }
    return meta.savedPath
  } catch (error) {
    console.error('儲存 session 失敗', error)
    logs.push({
      level: 'error',
      message: `✖ Session 儲存失敗：${String(error)}（工作目錄：${item.workingDirectory || '（未設定）'}）`,
      timestamp: Date.now(),
    })
    if (selectedItemId === item.id && viewingSessionData === null) renderMessageBox(item.id)
    return null
  }
}

/** 載入並渲染歷史 session 清單 */
async function loadAndRenderSessions(item: ListItem): Promise<void> {
  if (!isTauri()) {
    sessionListEl.innerHTML = '<span class="session-placeholder">（需要 Tauri 環境）</span>'
    return
  }

  try {
    const sessions = await invoke<SessionFileMeta[]>('list_sessions', {
      workingDirectory: item.workingDirectory,
      subdir: item.code,
    })
    loadedSessions = sessions
    renderSessionHistory(sessions)
  } catch (error) {
    console.error('載入 session 清單失敗', error)
    sessionListEl.innerHTML = '<span class="session-placeholder">載入失敗</span>'
  }
}

/** 渲染歷史 session 清單 */
function renderSessionHistory(sessions: SessionFileMeta[]): void {
  sessionListEl.innerHTML = ''

  if (sessions.length === 0) {
    sessionListEl.innerHTML = '<span class="session-placeholder">尚無歷史 Session</span>'
    return
  }

  sessions.forEach((meta) => {
    const item = document.createElement('div')
    item.className = 'session-item'
    if (meta.path === viewingSessionPath) item.classList.add('active')

    // 從檔名解析時間戳記
    const timeLabel = formatSessionFileLabel(meta.filename)
    const timeEl = document.createElement('span')
    timeEl.className = 'session-item-time'
    timeEl.textContent = timeLabel
    timeEl.title = meta.filename

    const metaEl = document.createElement('span')
    metaEl.className = 'session-item-meta'
    metaEl.textContent = new Date(meta.modifiedAt).toLocaleTimeString('zh-TW', { hour12: false })

    item.appendChild(timeEl)
    item.appendChild(metaEl)
    item.addEventListener('click', () => void viewSession(meta.path))
    sessionListEl.appendChild(item)
  })
}

/** 更新 session 清單的 active 狀態（不重新渲染） */
function renderSessionHistoryActiveState(): void {
  sessionListEl.querySelectorAll('.session-item').forEach((el, idx) => {
    const meta = loadedSessions[idx]
    if (meta) {
      el.classList.toggle('active', meta.path === viewingSessionPath)
    }
  })
}

/** 從 session 檔名解析顯示標籤 */
function formatSessionFileLabel(filename: string): string {
  // session_yyyyMMdd_HHmmss_SSS.json → yyyy-MM-dd HH:mm:ss
  const match = filename.match(/session_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
  if (!match) return filename.replace('.json', '')
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`
}

/** 查看指定路徑的歷史 session */
async function viewSession(path: string): Promise<void> {
  if (!isTauri()) return
  try {
    const raw = await invoke<string>('read_session_file', { path })
    const session: SessionData = JSON.parse(raw)
    viewingSessionData = session
    viewingSessionPath = path
    renderSessionViewInPanel(session)
    renderSessionHistoryActiveState()
  } catch (error) {
    console.error('讀取 session 失敗', error)
  }
}

/** 在右側面板渲染歷史 session 的 exchanges */
function renderSessionViewInPanel(session: SessionData): void {
  const startTime = new Date(session.startedAt).toLocaleTimeString('zh-TW', { hour12: false })
  const date = new Date(session.startedAt).toLocaleDateString('zh-TW')
  msgPanelTitle.textContent = `📂 歷史 ${date} ${startTime}`
  msgItemName.textContent = session.itemName

  const phaseLabels: Record<string, string> = {
    request: '→ 發送給 AI Model',
    response: '← AI Model 回應',
    tool: '⚙ Tool 執行',
    error: '✖ AI Model 錯誤',
    vector_search: '🔍 向量搜尋 tools',
    user_input: '💬 使用者插話',
    command_output: '🖥 Command 輸出',
  }
  const levelMap: Record<string, string> = {
    request: 'info',
    response: 'success',
    tool: 'system',
    error: 'error',
    vector_search: 'system',
    user_input: 'info',
    command_output: 'system',
  }

  const logs: LogEntry[] = session.logs ?? []
  if (logs.length === 0) {
    session.exchanges.forEach((ex) => {
      if (ex.phase === 'command_output') {
        upsertCommandOutputLog(logs, ex.payload, ex.timestamp)
        return
      }
      const label = phaseLabels[ex.phase] ?? ex.phase
      const level = (levelMap[ex.phase] ?? 'info') as LogLevel
      const payload = JSON.stringify(ex.payload, null, 2)
      const detailEntry: LogEntry = {
        level,
        message: `[AI Round ${ex.round}] ${label}\nEndpoint：${ex.endpoint}\n${payload}`,
        timestamp: ex.timestamp,
        kind: 'detail',
      }
      const simpleEntry = makeSimpleExchangeEntry(ex.phase, ex.round, ex.payload, ex.timestamp)
      logs.push(detailEntry)
      if (simpleEntry) logs.push(simpleEntry)
    })
  }

  msgContent.innerHTML = logsToHtml(logs)
  msgContent.scrollTop = 0
}

/** 切回即時執行過程模式 */
function showLiveViewInPanel(itemId: number): void {
  msgPanelTitle.textContent = '📋 執行過程'
  renderMessageBox(itemId)
}

// ============================================================
// 對話框邏輯
// ============================================================

/** 從 Tauri 或 localStorage 讀取使用者自訂群組 */
async function loadUserPresets(): Promise<Preset[]> {
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      return settings.userPresets || []
    } catch { /* Tauri 失敗時 fallback */ }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PRESETS)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as Preset[]
    }
  } catch { /* 忽略損壞的資料 */ }
  return []
}

/** 將使用者自訂群組寫入 Tauri 或 localStorage */
async function saveUserPresets(presets: Preset[]): Promise<void> {
  localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(presets))
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      settings.userPresets = presets
      settings.enableHttpInput = true
      await invoke('write_settings', { settings })
    } catch { /* Tauri 失敗時至少已存 localStorage */ }
  }
}

/** 從 Tauri 或 localStorage 讀取項目列表 */
async function loadItems(): Promise<ListItem[]> {
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      return hydrateItems(settings.items || [])
    } catch { /* Tauri 失敗時 fallback */ }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ITEMS)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return hydrateItems(parsed as PersistedListItem[])
    }
  } catch { /* 忽略損壞的資料 */ }
  return []
}

/** 將項目列表寫入 Tauri 或 localStorage，同時保存 nextId */
async function saveItems(): Promise<void> {
  const persistedItems = getPersistedItems()
  localStorage.setItem(STORAGE_KEY_ITEMS, JSON.stringify(persistedItems))
  localStorage.setItem(STORAGE_KEY_NEXT_ID, String(nextId))
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      settings.items = persistedItems
      settings.enableHttpInput = true
      await invoke('write_settings', { settings })
    } catch { /* Tauri 失敗時至少已存 localStorage */ }
  }
}

async function loadScheduledEvents(): Promise<ScheduledEvent[]> {
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      return Array.isArray(settings.events) ? settings.events : []
    } catch { /* Tauri 失敗時 fallback */ }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY_EVENTS)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as ScheduledEvent[]
    }
  } catch { /* 忽略損壞的資料 */ }
  return []
}

async function saveScheduledEvents(): Promise<void> {
  scheduledEvents.sort((a, b) => a.triggerAt - b.triggerAt)
  localStorage.setItem(STORAGE_KEY_EVENTS, JSON.stringify(scheduledEvents))
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      settings.events = scheduledEvents
      settings.enableHttpInput = true
      await invoke('write_settings', { settings })
    } catch { /* Tauri 失敗時至少已存 localStorage */ }
  }
}

// loadEnableHttp and saveEnableHttp have been removed

async function loadEventMappings(): Promise<EventMapping[]> {
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      if (Array.isArray(settings.eventMappings)) {
        return settings.eventMappings
      }
    } catch { /* Fallback */ }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY_EVENT_MAPPINGS)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as EventMapping[]
    }
  } catch { /* 忽略 */ }
  return []
}

async function saveEventMappings(): Promise<void> {
  localStorage.setItem(STORAGE_KEY_EVENT_MAPPINGS, JSON.stringify(eventMappings))
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      settings.eventMappings = eventMappings
      settings.enableHttpInput = true
      await invoke('write_settings', { settings })
    } catch { /* Fallback */ }
  }
}

function renderEventMappings(): void {
  eventMappingsList.innerHTML = ''
  if (eventMappings.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'events-empty'
    empty.textContent = '尚未設定事件訂閱'
    eventMappingsList.appendChild(empty)
    return
  }
  eventMappings.forEach((mapping) => {
    const row = document.createElement('div')
    row.className = 'event-row'

    const badge = document.createElement('span')
    badge.className = 'event-time'
    badge.textContent = mapping.eventId

    const agentName = document.createElement('span')
    agentName.className = 'event-agent'
    const agent = items.find((i) => i.id === mapping.agentId)
    agentName.textContent = agent ? agent.name : '找不到 Agent'

    const status = document.createElement('span')
    status.className = 'event-status'
    status.textContent = '自訂事件訂閱'

    const removeBtn = document.createElement('button')
    removeBtn.className = 'event-delete'
    removeBtn.type = 'button'
    removeBtn.textContent = '刪除'
    removeBtn.addEventListener('click', async () => {
      eventMappings = eventMappings.filter((m) => m.id !== mapping.id)
      await saveEventMappings()
      renderEventMappings()
      renderList()
    })

    row.append(badge, agentName, status, removeBtn)
    eventMappingsList.appendChild(row)
  })
}

function handleAgentEvent(eventId: string, message: string, arg1: string, arg2: string, arg3: string): void {
  const matched = eventMappings.filter(
    (m) => m.eventId.trim().toLowerCase() === eventId.trim().toLowerCase()
  )
  matched.forEach((mapping) => {
    const params = {
      message,
      arg1,
      arg2,
      arg3,
      eventId,
      _triggerSource: 'event'
    }
    void runItem(mapping.agentId, params)
  })
}

function formatEventTime(timestamp: number): string {
  const date = new Date(timestamp)
  const part = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`
}


function formatEventInterval(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`
  if (seconds % 3600 === 0) return `${seconds / 3600} 小時`
  return `${seconds / 60} 分鐘`
}

function getEventIntervalSeconds(): number {
  const value = Math.max(1, Math.floor(Number(inputEventInterval.value) || 1))
  const multipliers: Record<string, number> = { minutes: 60, hours: 3600, days: 86400 }
  return value * (multipliers[selectEventIntervalUnit.value] ?? 60)
}

function updateRecurrenceFields(): void {
  eventIntervalFields.classList.toggle('hidden', selectEventRecurrence.value !== 'interval')
}

function renderScheduledEvents(): void {
  eventsList.innerHTML = ''
  btnEvents.title = scheduledEvents.length > 0 ? `事件設定（${scheduledEvents.length}）` : '事件設定'

  if (scheduledEvents.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'events-empty'
    empty.textContent = '尚未設定事件'
    eventsList.appendChild(empty)
    return
  }

  const sortedEvents = [...scheduledEvents].sort((a, b) => {
    const aFinished = a.recurrence === 'once' && !!a.executedAt
    const bFinished = b.recurrence === 'once' && !!b.executedAt
    return Number(aFinished) - Number(bFinished) || a.triggerAt - b.triggerAt
  })

  sortedEvents.forEach((scheduledEvent) => {
    const row = document.createElement('div')
    row.className = 'event-row'
    if (scheduledEvent.recurrence === 'once' && scheduledEvent.executedAt) row.classList.add('executed')

    const time = document.createElement('span')
    time.className = 'event-time'
    time.textContent = `${scheduledEvent.recurrence === 'interval' ? '下次：' : ''}${formatEventTime(scheduledEvent.triggerAt)}`

    const agent = document.createElement('span')
    agent.className = 'event-agent'
    agent.textContent = items.find((item) => item.id === scheduledEvent.agentId)?.name ?? '找不到 Agent'

    const status = document.createElement('span')
    status.className = 'event-status'
    if (scheduledEvent.recurrence === 'interval') {
      status.classList.add('recurring')
      status.textContent = `每 ${formatEventInterval(scheduledEvent.intervalSeconds ?? 60)}｜已執行 ${scheduledEvent.executionCount} 次${scheduledEvent.executedAt ? `\n上次：${formatEventTime(scheduledEvent.executedAt)}` : ''}`
    } else if (scheduledEvent.executedAt) {
      status.textContent = `✓ 已執行\n${formatEventTime(scheduledEvent.executedAt)}`
    } else {
      status.classList.add('pending')
      status.textContent = '等待執行'
    }

    const remove = document.createElement('button')
    remove.className = 'event-delete'
    remove.type = 'button'
    remove.textContent = '刪除'
    remove.addEventListener('click', async () => {
      scheduledEvents = scheduledEvents.filter((event) => event.id !== scheduledEvent.id)
      await saveScheduledEvents()
      renderScheduledEvents()
      renderList()
    })

    row.append(time, agent, status, remove)
    eventsList.appendChild(row)
  })
}

// ============================================================
// Clock Picker
// ============================================================

function clockMarkPos(index: number, total: number, r: number): { x: number; y: number } {
  const angle = (index / total) * 2 * Math.PI - Math.PI / 2
  return { x: 110 + r * Math.cos(angle), y: 110 + r * Math.sin(angle) }
}

function clockAppend<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  text?: string
): SVGElementTagNameMap[K] {
  const NS = 'http://www.w3.org/2000/svg'
  const el = document.createElementNS(NS, tag) as SVGElementTagNameMap[K]
  for (const [k, v] of Object.entries(attrs)) (el as Element).setAttribute(k, String(v))
  if (text !== undefined) el.textContent = text
  clockSvg.appendChild(el)
  return el
}

function renderClockFace(): void {
  while (clockSvg.firstChild) clockSvg.removeChild(clockSvg.firstChild)
  const cx = 110, cy = 110

  clockAppend('circle', { cx, cy, r: 100, class: 'clock-face-bg' })

  if (clockPhase === 'hour') {
    const selH12 = clockHour24 % 12 || 12
    const { x: sx, y: sy } = clockMarkPos(selH12, 12, 80)
    clockAppend('line', { x1: cx, y1: cy, x2: sx, y2: sy, class: 'clock-hand' })
    clockAppend('circle', { cx: sx, cy: sy, r: 17, class: 'clock-mark-sel' })
    for (let h = 1; h <= 12; h++) {
      const { x, y } = clockMarkPos(h, 12, 80)
      clockAppend('text', {
        x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        class: h === selH12 ? 'clock-mark-text sel' : 'clock-mark-text'
      }, `${h}`)
    }
  } else {
    const isFiveSel = clockMinute % 5 === 0
    const selR = isFiveSel ? 78 : 84
    const { x: sx, y: sy } = clockMarkPos(clockMinute, 60, selR)
    clockAppend('line', { x1: cx, y1: cy, x2: sx, y2: sy, class: 'clock-hand' })
    clockAppend('circle', { cx: sx, cy: sy, r: isFiveSel ? 17 : 7, class: 'clock-mark-sel' })
    for (let m = 0; m < 60; m++) {
      if (m % 5 !== 0 && m !== clockMinute) {
        const { x, y } = clockMarkPos(m, 60, 84)
        clockAppend('circle', { cx: x, cy: y, r: 3, class: 'clock-dot' })
      }
    }
    for (let m = 0; m < 60; m += 5) {
      const { x, y } = clockMarkPos(m, 60, 78)
      clockAppend('text', {
        x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        class: m === clockMinute ? 'clock-mark-text sel' : 'clock-mark-text'
      }, m === 0 ? '00' : `${m}`)
    }
  }

  clockAppend('circle', { cx, cy, r: 3, class: 'clock-center-dot' })
}

function updateClockDisplay(): void {
  const isAm = clockHour24 < 12
  const h12 = clockHour24 % 12 || 12
  const minStr = String(clockMinute).padStart(2, '0')
  clockTimeBtn.textContent = `${h12}:${minStr} ${isAm ? '上午' : '下午'}`
  clockDispHour.textContent = String(h12)
  clockDispMinute.textContent = minStr
  btnAm.classList.toggle('active', isAm)
  btnPm.classList.toggle('active', !isAm)
  clockDispHour.classList.toggle('active', clockPhase === 'hour')
  clockDispMinute.classList.toggle('active', clockPhase === 'minute')
  clockPopupHint.textContent = clockPhase === 'hour' ? '點選選擇小時' : '點選選擇分鐘'
  renderClockFace()
}

function setClockFromTimestamp(ts: number): void {
  const date = new Date(ts)
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  inputEventDate.value = `${y}-${mo}-${d}`
  clockHour24 = date.getHours()
  clockMinute = date.getMinutes()
  clockPhase = 'hour'
  updateClockDisplay()
}

function getClockTimestamp(): number {
  const dateStr = inputEventDate.value
  if (!dateStr) return NaN
  const [y, mo, d] = dateStr.split('-').map(Number)
  return new Date(y, mo - 1, d, clockHour24, clockMinute, 0, 0).getTime()
}

function openClockPopup(): void {
  const rect = clockTimeBtn.getBoundingClientRect()
  const popupWidth = 268
  let left = rect.left
  if (left + popupWidth > window.innerWidth - 8) left = window.innerWidth - popupWidth - 8
  clockPopup.style.top = `${rect.bottom + 4}px`
  clockPopup.style.left = `${left}px`
  clockPhase = 'hour'
  updateClockDisplay()
  clockPopup.classList.remove('hidden')
}

function closeClockPopup(): void {
  clockPopup.classList.add('hidden')
}

clockTimeBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  clockPopup.classList.contains('hidden') ? openClockPopup() : closeClockPopup()
})

document.addEventListener('click', (e) => {
  if (!clockPopup.classList.contains('hidden') &&
      !clockPopup.contains(e.target as Node) &&
      e.target !== clockTimeBtn) {
    closeClockPopup()
  }
})

btnAm.addEventListener('click', () => {
  if (clockHour24 >= 12) clockHour24 -= 12
  updateClockDisplay()
})

btnPm.addEventListener('click', () => {
  if (clockHour24 < 12) clockHour24 += 12
  updateClockDisplay()
})

clockDispHour.addEventListener('click', () => {
  clockPhase = 'hour'
  updateClockDisplay()
})

clockDispMinute.addEventListener('click', () => {
  clockPhase = 'minute'
  updateClockDisplay()
})

clockSvg.addEventListener('click', (e) => {
  e.stopPropagation()  // renderClockFace() removes e.target from DOM, causing document handler to misfire
  const rect = (clockSvg as Element).getBoundingClientRect()
  const x = (e.clientX - rect.left) * (220 / rect.width)
  const y = (e.clientY - rect.top) * (220 / rect.height)
  const dx = x - 110, dy = y - 110
  if (dx * dx + dy * dy < 400) return  // Too close to center (r < 20)
  const angle = ((Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI))

  if (clockPhase === 'hour') {
    const h12Raw = Math.round(angle / (2 * Math.PI) * 12) % 12
    const h12 = h12Raw === 0 ? 12 : h12Raw
    const isAm = clockHour24 < 12
    clockHour24 = isAm ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12)
    clockPhase = 'minute'
    updateClockDisplay()
  } else {
    clockMinute = Math.round(angle / (2 * Math.PI) * 60) % 60
    updateClockDisplay()
    closeClockPopup()
  }
})

function openEventsDialog(): void {
  selectEventAgent.innerHTML = ''
  selectMappingAgent.innerHTML = ''
  items.forEach((item) => {
    const option1 = document.createElement('option')
    option1.value = String(item.id)
    option1.textContent = item.name
    selectEventAgent.appendChild(option1)

    const option2 = document.createElement('option')
    option2.value = String(item.id)
    option2.textContent = item.name
    selectMappingAgent.appendChild(option2)
  })
  btnAddEvent.disabled = items.length === 0
  btnAddMapping.disabled = items.length === 0
  setClockFromTimestamp(Date.now() + 5 * 60 * 1000)
  selectEventRecurrence.value = 'once'
  inputEventInterval.value = '1'
  selectEventIntervalUnit.value = 'minutes'
  inputMappingEventId.value = ''
  updateRecurrenceFields()
  renderScheduledEvents()
  renderEventMappings()
  renderHttpAgentsList()
  eventsOverlay.classList.remove('hidden')
}

function closeEventsDialog(): void {
  eventsOverlay.classList.add('hidden')
}

async function checkScheduledEventTriggers(): Promise<void> {
  if (checkingScheduledEvents) return
  const now = Date.now()
  const dueEvents = scheduledEvents.filter((event) =>
    event.triggerAt <= now && (event.recurrence === 'interval' || !event.executedAt))
  if (dueEvents.length === 0) return

  checkingScheduledEvents = true
  try {
    dueEvents.forEach((scheduledEvent) => {
      scheduledEvent.executedAt = now
      scheduledEvent.executionCount += 1
      if (scheduledEvent.recurrence === 'interval') {
        const intervalMs = Math.max(60, scheduledEvent.intervalSeconds ?? 60) * 1000
        do scheduledEvent.triggerAt += intervalMs
        while (scheduledEvent.triggerAt <= now)
      }
    })
    await saveScheduledEvents()
    renderScheduledEvents()
    renderList()

    dueEvents.sort((a, b) => a.triggerAt - b.triggerAt).forEach((scheduledEvent) => {
      const item = items.find((candidate) => candidate.id === scheduledEvent.agentId)
      if (!item) return
      if (!itemLogs.has(item.id)) itemLogs.set(item.id, [])
      itemLogs.get(item.id)!.push({
        level: 'system',
        message: `⏰ ${scheduledEvent.recurrence === 'interval' ? '循環' : '一次性'}事件已觸發：${formatEventTime(now)}`,
        timestamp: Date.now(),
      })
      if (selectedItemId === item.id && viewingSessionData === null) renderMessageBox(item.id)
      void runItem(item.id)
    })
  } finally {
    checkingScheduledEvents = false
  }
}

/** 填入下拉選單 */
async function populatePresetDropdown(): Promise<void> {
  const userPresets = await loadUserPresets()

  // 清空並重建選項
  selectPreset.innerHTML = '<option value="">自訂</option>'

  // 使用者自訂群組
  if (userPresets.length > 0) {
    const userGroup = document.createElement('optgroup')
    userGroup.label = '我的群組'
    userPresets.forEach((p, idx) => {
      const opt = document.createElement('option')
      opt.value = `user:${idx}`
      opt.textContent = p.name
      userGroup.appendChild(opt)
    })
    selectPreset.appendChild(userGroup)
  }

  // 內建群組
  const builtinGroup = document.createElement('optgroup')
  builtinGroup.label = '內建群組'
  DEFAULT_PRESETS.forEach((p, idx) => {
    const opt = document.createElement('option')
    opt.value = `builtin:${idx}`
    opt.textContent = p.name
    builtinGroup.appendChild(opt)
  })
  selectPreset.appendChild(builtinGroup)
}


/** 根據目前欄位值自動選取對應的下拉選項 */
async function selectMatchingPreset(): Promise<void> {
  const userPresets = await loadUserPresets()
  const baseUrl = inputApiBaseUrl.value.trim()
  const key = inputApiKey.value.trim()
  const model = inputModelName.value.trim()

  // 先檢查使用者自訂群組
  for (let i = 0; i < userPresets.length; i++) {
    const p = userPresets[i]
    if (p.apiBaseUrl === baseUrl && p.apiKey === key && p.modelName === model) {
      selectPreset.value = `user:${i}`
      return
    }
  }

  // 再檢查內建群組
  for (let i = 0; i < DEFAULT_PRESETS.length; i++) {
    const p = DEFAULT_PRESETS[i]
    if (p.apiBaseUrl === baseUrl && p.apiKey === key && p.modelName === model) {
      selectPreset.value = `builtin:${i}`
      return
    }
  }

  // 無匹配
  selectPreset.value = ''
}

/** 下拉選單變更時，自動填入對應欄位 */
async function onPresetChange(): Promise<void> {
  const value = selectPreset.value
  if (!value) return // 「自訂」選項，不動作

  let preset: Preset | null = null

  if (value.startsWith('user:')) {
    const idx = parseInt(value.slice(5), 10)
    const userPresets = await loadUserPresets()
    preset = userPresets[idx] ?? null
  } else if (value.startsWith('builtin:')) {
    const idx = parseInt(value.slice(8), 10)
    preset = DEFAULT_PRESETS[idx] ?? null
  }

  if (preset) {
    inputApiBaseUrl.value = preset.apiBaseUrl
    inputApiKey.value = preset.apiKey
    inputModelName.value = preset.modelName
  }
}

/** 將目前的 API 設定欄位值存回下拉選單選擇的 AI 模型群組 */
async function saveCurrentFieldsToSelectedPreset(apiBaseUrl: string, apiKey: string, modelName: string): Promise<void> {
  const value = selectPreset.value
  if (!value) return // 「自訂」選項，不動作

  if (value.startsWith('user:')) {
    // 更新現有的使用者自訂群組
    const idx = parseInt(value.slice(5), 10)
    const userPresets = await loadUserPresets()
    if (idx >= 0 && idx < userPresets.length) {
      userPresets[idx].apiBaseUrl = apiBaseUrl
      userPresets[idx].apiKey = apiKey
      userPresets[idx].modelName = modelName
      await saveUserPresets(userPresets)
      await populatePresetDropdown()
      selectPreset.value = `user:${idx}`
    }
  } else if (value.startsWith('builtin:')) {
    // 內建群組不可修改，建立一個同名的使用者群組來覆蓋
    const idx = parseInt(value.slice(8), 10)
    const builtin = DEFAULT_PRESETS[idx]
    if (!builtin) return

    // 檢查欄位值是否與內建群組相同，若相同則無需建立使用者群組
    if (builtin.apiBaseUrl === apiBaseUrl && builtin.apiKey === apiKey && builtin.modelName === modelName) return

    const userPresets = await loadUserPresets()
    const existingIdx = userPresets.findIndex((p) => p.name === builtin.name)

    const newPreset: Preset = {
      name: builtin.name,
      apiBaseUrl,
      apiKey,
      modelName,
    }

    if (existingIdx >= 0) {
      userPresets[existingIdx] = newPreset
    } else {
      userPresets.push(newPreset)
    }

    await saveUserPresets(userPresets)
    await populatePresetDropdown()
    selectPreset.value = `user:${existingIdx >= 0 ? existingIdx : userPresets.length - 1}`
  }
}

/** 將目前欄位設定儲存為新的自訂群組 */
async function saveAsPreset(): Promise<void> {
  const baseUrl = inputApiBaseUrl.value.trim()
  const key = inputApiKey.value.trim()
  const model = inputModelName.value.trim()

  if (!baseUrl && !key && !model) {
    alert('請至少填寫一個欄位再儲存為群組。')
    return
  }

  const name = prompt('請輸入此群組的名稱：', model || '自訂群組')
  if (!name || !name.trim()) return

  const userPresets = await loadUserPresets()

  // 檢查是否已存在相同名稱
  const existingIdx = userPresets.findIndex((p) => p.name === name.trim())
  const newPreset: Preset = {
    name: name.trim(),
    apiBaseUrl: baseUrl,
    apiKey: key,
    modelName: model,
  }

  if (existingIdx >= 0) {
    userPresets[existingIdx] = newPreset
  } else {
    userPresets.push(newPreset)
  }

  await saveUserPresets(userPresets)
  await populatePresetDropdown()
  selectPreset.value = `user:${existingIdx >= 0 ? existingIdx : userPresets.length - 1}`
}

/** 從後端載入 skills 並渲染成 checkbox 清單 */
async function loadAndRenderSkills(selectedSkills: string[]): Promise<void> {
  skillListEl.innerHTML = '<span class="skill-placeholder">載入中…</span>'
  try {
    availableSkills = isTauri() ? await invoke<SkillMeta[]>('list_skills') : []
  } catch {
    availableSkills = []
  }
  if (availableSkills.length === 0) {
    skillListEl.innerHTML = '<span class="skill-placeholder">（尚無 Skill 檔案，請在 App 目錄下的 skills/ 資料夾新增 .json 檔案）</span>'
    return
  }
  skillListEl.innerHTML = availableSkills
    .map(
      (skill) =>
        `<label class="skill-option" title="${escapeHtml(skill.description)}">` +
        `<input type="checkbox" name="agent-skill" value="${escapeHtml(skill.id)}"` +
        (selectedSkills.includes(skill.id) ? ' checked' : '') +
        ` /> <span class="skill-name">${escapeHtml(skill.name)}</span>` +
        (skill.description ? `<span class="skill-desc">${escapeHtml(skill.description)}</span>` : '') +
        `</label>`,
    )
    .join('')
}

/** 取得目前勾選的 skill id 清單 */
function getCheckedSkills(): string[] {
  return Array.from(skillListEl.querySelectorAll<HTMLInputElement>('input[name="agent-skill"]:checked')).map(
    (cb) => cb.value,
  )
}

// ============================================================
// MCP Server UI
// ============================================================

const mcpServerListEl = document.getElementById('mcp-server-list') as HTMLElement
const mcpToolSectionEl = document.getElementById('mcp-tool-section') as HTMLElement

function makeMcpRow(cfg: McpServerConfig, idx: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'mcp-server-row'
  row.dataset.index = String(idx)

  const enabledCb = document.createElement('input')
  enabledCb.type = 'checkbox'
  enabledCb.className = 'mcp-enabled'
  enabledCb.checked = cfg.enabled
  enabledCb.title = '啟用'

  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'mcp-name form-input'
  nameInput.placeholder = '名稱'
  nameInput.value = cfg.name

  const transportSel = document.createElement('select')
  transportSel.className = 'mcp-transport form-select'
  ;(['stdio', 'http'] as const).forEach((t) => {
    const opt = document.createElement('option')
    opt.value = t
    opt.textContent = t
    if (cfg.transport === t) opt.selected = true
    transportSel.appendChild(opt)
  })

  const commandInput = document.createElement('input')
  commandInput.type = 'text'
  commandInput.className = 'mcp-command form-input'
  commandInput.placeholder = '指令（含參數，空白分隔）'
  commandInput.value = cfg.command + (cfg.args.length > 0 ? ' ' + cfg.args.join(' ') : '')

  const urlInput = document.createElement('input')
  urlInput.type = 'text'
  urlInput.className = 'mcp-url form-input'
  urlInput.placeholder = 'http://localhost:3000'
  urlInput.value = cfg.url

  // env vars 一行一個「KEY=VALUE」；只在 stdio 模式下有用
  const envInput = document.createElement('textarea')
  envInput.className = 'mcp-env form-input'
  envInput.rows = 2
  envInput.placeholder = 'ENV_VAR=value（每行一個，選填）'
  envInput.value = Object.entries(cfg.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const updateVisibility = () => {
    const isStdio = transportSel.value === 'stdio'
    commandInput.style.display = isStdio ? '' : 'none'
    envInput.style.display = isStdio ? '' : 'none'
    urlInput.style.display = isStdio ? 'none' : ''
  }
  updateVisibility()
  transportSel.addEventListener('change', updateVisibility)

  const delBtn = document.createElement('button')
  delBtn.type = 'button'
  delBtn.className = 'btn-icon mcp-delete'
  delBtn.title = '刪除'
  delBtn.textContent = '✕'
  delBtn.addEventListener('click', () => row.remove())

  row.append(enabledCb, nameInput, transportSel, commandInput, urlInput, envInput, delBtn)
  return row
}

function renderMcpServers(servers: McpServerConfig[]): void {
  mcpServerListEl.innerHTML = ''
  servers.forEach((s, i) => mcpServerListEl.appendChild(makeMcpRow(s, i)))
}

function getMcpServersFromUI(): McpServerConfig[] {
  return Array.from(mcpServerListEl.querySelectorAll<HTMLElement>('.mcp-server-row')).map((row) => {
    const transport = (row.querySelector<HTMLSelectElement>('.mcp-transport')!.value) as 'stdio' | 'http'
    const commandLine = row.querySelector<HTMLInputElement>('.mcp-command')!.value.trim()
    const [command, ...args] = commandLine.split(/\s+/).filter(Boolean)
    const envRaw = row.querySelector<HTMLTextAreaElement>('.mcp-env')?.value ?? ''
    const env: Record<string, string> = {}
    envRaw.split('\n').forEach((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return
      const eq = trimmed.indexOf('=')
      if (eq <= 0) return  // 沒有 = 或 = 在最前面 → 跳過
      const k = trimmed.slice(0, eq).trim()
      const v = trimmed.slice(eq + 1)  // value 保留原樣（含前後空白）
      if (k) env[k] = v
    })
    return {
      name: row.querySelector<HTMLInputElement>('.mcp-name')!.value.trim(),
      enabled: row.querySelector<HTMLInputElement>('.mcp-enabled')!.checked,
      transport,
      command: command ?? '',
      args,
      env,
      url: row.querySelector<HTMLInputElement>('.mcp-url')!.value.trim(),
    }
  })
}

async function fetchAndRenderMcpTools(servers: McpServerConfig[], selectedMcpTools: string[], workingDirectory: string): Promise<void> {
  const enabledServers = servers.filter((s) => s.enabled && (s.command.trim() || s.url.trim()))
  if (!isTauri() || enabledServers.length === 0) {
    mcpToolSectionEl.innerHTML = ''
    return
  }
  mcpToolSectionEl.innerHTML = '<span class="skill-placeholder">取得 MCP 工具中…</span>'

  const allTools: Array<{ serverName: string; toolName: string; description: string }> = []
  const allErrors: string[] = []
  for (const server of enabledServers) {
    try {
      const tools = await invoke<Array<{ name: string; description: string }>>('list_mcp_server_tools', { server, workingDirectory })
      for (const tool of tools) allTools.push({ serverName: server.name, toolName: tool.name, description: tool.description })
    } catch (e) {
      console.warn(`MCP ${server.name} 取得工具失敗:`, e)
      allErrors.push(`[${server.name}] ${String(e)}`)
    }
  }

  if (allTools.length === 0) {
    const msg = allErrors.length > 0
      ? allErrors.map(escapeHtml).join('<br>')
      : 'MCP server 無可用工具'
    mcpToolSectionEl.innerHTML = `<span class="skill-placeholder mcp-tool-error">${msg}</span>`
    return
  }

  mcpToolSectionEl.innerHTML =
    '<div class="mcp-tool-divider">— MCP 工具 —</div>' +
    allTools
      .map(({ serverName, toolName, description }) => {
        const key = `${serverName}::${toolName}`
        const serverHasSavedTools = selectedMcpTools.includes(`${serverName}::__configured__`)
        const checked = serverHasSavedTools ? selectedMcpTools.includes(key) : true
        return (
          `<label class="tool-option" title="${escapeHtml(description)}">` +
          `<input type="checkbox" name="mcp-tool" value="${escapeHtml(key)}"${checked ? ' checked' : ''} />` +
          ` <span class="mcp-tool-server">[${escapeHtml(serverName)}]</span>${escapeHtml(toolName)}` +
          `</label>`
        )
      })
      .join('')
}

function getCheckedMcpTools(): string[] {
  return Array.from(mcpToolSectionEl.querySelectorAll<HTMLInputElement>('input[name="mcp-tool"]:checked')).map(
    (cb) => cb.value,
  )
}

/** 開啟設定對話框 */
async function openSettingsDialog(itemId: number): Promise<void> {
  const item = items.find((i) => i.id === itemId)
  if (!item) return

  editingItemId = itemId

  // 填入目前值
  inputName.value = item.name
  inputAgentId.value = item.agentId
  inputPrompt.value = item.prompt
  inputApiBaseUrl.value = item.apiBaseUrl
  inputApiKey.value = item.apiKey
  inputModelName.value = item.modelName
  inputWorkingDirectory.value = item.workingDirectory
  toolCheckboxes.forEach((checkbox) => {
    checkbox.checked = item.tools.includes(checkbox.value as ToolName)
  })
  inputMemory.checked = item.memory
  inputToolsSearch.checked = item.toolsSearch
  inputMaxRounds.value = String(item.maxRounds)

  settingsOverlay.classList.remove('hidden')

  // 載入並渲染 skills 清單
  await loadAndRenderSkills(item.skills)

  // 渲染 MCP servers
  renderMcpServers(item.mcpServers)

  // 自動取得 MCP 工具並顯示在 Agent Tools 群組
  mcpToolSectionEl.innerHTML = ''
  fetchAndRenderMcpTools(item.mcpServers, item.mcpTools, item.workingDirectory)

  // 填入下拉選單並自動選取匹配的 preset
  await populatePresetDropdown()
  await selectMatchingPreset()

  inputName.focus()
}

/** 關閉設定對話框 */
function closeSettingsDialog(): void {
  settingsOverlay.classList.add('hidden')
  editingItemId = null
}

/** 載入全域設定 */
async function loadGlobalSettings(): Promise<void> {
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      globalEmbeddingApiBaseUrl = settings.embeddingApiBaseUrl || ''
      globalEmbeddingApiKey = settings.embeddingApiKey || ''
      globalEmbeddingModel = settings.embeddingModel || ''
    } catch { /* fallback */ }
  }
  if (!globalEmbeddingApiBaseUrl) {
    globalEmbeddingApiBaseUrl = localStorage.getItem('global_embedding_base_url') || ''
  }
  if (!globalEmbeddingApiKey) {
    globalEmbeddingApiKey = localStorage.getItem('global_embedding_api_key') || ''
  }
  if (!globalEmbeddingModel) {
    globalEmbeddingModel = localStorage.getItem('global_embedding_model') || ''
  }

  execFontSize = parseInt(localStorage.getItem('exec_font_size') || '13', 10)
  applyFontSizes()

  inputEmbeddingBaseUrl.value = globalEmbeddingApiBaseUrl
  inputEmbeddingApiKey.value = globalEmbeddingApiKey
  inputEmbeddingModel.value = globalEmbeddingModel
}

/** 套用字體大小 CSS 變數 */
function applyFontSizes(): void {
  document.documentElement.style.setProperty('--exec-font-size', `${execFontSize}px`)
  execFontSizeVal.textContent = `${execFontSize}px`
}

/** 儲存全域設定 */
async function saveGlobalSettings(): Promise<void> {
  globalEmbeddingApiBaseUrl = inputEmbeddingBaseUrl.value.trim()
  globalEmbeddingApiKey = inputEmbeddingApiKey.value
  globalEmbeddingModel = inputEmbeddingModel.value.trim()

  localStorage.setItem('global_embedding_base_url', globalEmbeddingApiBaseUrl)
  localStorage.setItem('global_embedding_api_key', globalEmbeddingApiKey)
  localStorage.setItem('global_embedding_model', globalEmbeddingModel)
  localStorage.setItem('exec_font_size', String(execFontSize))

  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      settings.embeddingApiBaseUrl = globalEmbeddingApiBaseUrl
      settings.embeddingApiKey = globalEmbeddingApiKey
      settings.embeddingModel = globalEmbeddingModel
      settings.enableHttpInput = true
      await invoke('write_settings', { settings })
    } catch (e) {
      console.error('Failed to save global settings via Tauri:', e)
    }
  }
}

/** 開啟全域設定對話框 */
function openGlobalSettings(): void {
  inputEmbeddingBaseUrl.value = globalEmbeddingApiBaseUrl
  inputEmbeddingApiKey.value = globalEmbeddingApiKey
  inputEmbeddingModel.value = globalEmbeddingModel
  applyFontSizes()
  globalSettingsOverlay.classList.remove('hidden')
}

/** 關閉全域設定對話框 */
function closeGlobalSettings(): void {
  globalSettingsOverlay.classList.add('hidden')
}

/** 刪除 Agent */
async function deleteSettings(): Promise<void> {
  if (editingItemId === null) return

  // 1. 若該 Agent 正在執行，提示無法刪除
  if (runningItems.has(editingItemId)) {
    window.alert('此 Agent 正在執行中，請先停止或等待執行結束後再刪除。')
    return
  }

  // 2. 顯示確認對話框
  const item = items.find((i) => i.id === editingItemId)
  if (!item) return

  const confirmed = window.confirm(`確定要刪除 Agent「${item.name}」嗎？此動作無法復原。`)
  if (!confirmed) return
  const typedName = window.prompt(`請再次確認：輸入 Agent 名稱「${item.name}」才能刪除。`)
  if (typedName !== item.name) {
    window.alert('Agent 名稱不一致，已取消刪除。')
    return
  }

  // 3. 從 items 陣列中移除
  items = items.filter((i) => i.id !== editingItemId)

  // 4. 清除與此 Agent 相關的事件和對應
  scheduledEvents = scheduledEvents.filter((event) => event.agentId !== editingItemId)
  eventMappings = eventMappings.filter((mapping) => mapping.agentId !== editingItemId)

  // 5. 記憶體/變數狀態清理
  itemLogs.delete(editingItemId)
  currentSessionExchanges.delete(editingItemId)
  currentSessionStartedAt.delete(editingItemId)
  itemTaskQueues.delete(editingItemId)
  lastTaskByAgent.delete(item.name)

  // 6. 若被刪除的正是目前選取的 Agent，將其設為選取 null
  if (selectedItemId === editingItemId) {
    selectedItemId = null
    viewingSessionData = null
    viewingSessionPath = null
    renderMessageBox(null)
    sessionListEl.innerHTML = '<span class="session-placeholder">請選取項目以查看 Session</span>'
  }

  // 7. 儲存設定並更新 UI
  await saveItems()
  await saveScheduledEvents()
  await saveEventMappings()
  closeSettingsDialog()
  renderList()
  renderScheduledEvents()
  updateInputBoxState()
}

/** 儲存設定 */
async function saveSettings(): Promise<void> {
  if (editingItemId === null) return

  const name = inputName.value.trim() || `項目 ${editingItemId}`
  const prompt = inputPrompt.value.trim()
  const apiBaseUrl = inputApiBaseUrl.value.trim()
  const apiKey = inputApiKey.value.trim()
  const modelName = inputModelName.value.trim()
  const workingDirectory = inputWorkingDirectory.value.trim()
  const tools = toolCheckboxes
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value as ToolName)
  const skills = getCheckedSkills()

  if (items.some((candidate) => candidate.id !== editingItemId && itemNameKey(candidate.name) === itemNameKey(name))) {
    window.alert(`AGENT NAME「${name}」已存在，請使用不同名稱。`)
    inputName.focus()
    inputName.select()
    return
  }

  const item = items.find((i) => i.id === editingItemId)
  if (item) {
    item.name = name
    item.prompt = prompt
    item.apiBaseUrl = apiBaseUrl
    item.apiKey = apiKey
    item.modelName = modelName
    item.workingDirectory = workingDirectory
    item.tools = tools
    item.skills = skills
    item.mcpServers = getMcpServersFromUI()
    // Only update mcpTools when the section has been fetched (has checkboxes)
    const mcpToolInputs = mcpToolSectionEl.querySelectorAll<HTMLInputElement>('input[name="mcp-tool"]')
    if (mcpToolInputs.length > 0) {
      const renderedKeys = Array.from(mcpToolInputs).map((cb) => cb.value)
      const checkedKeys = getCheckedMcpTools()
      
      const renderedServers = Array.from(new Set(renderedKeys.map((key) => key.split('::')[0])))
      const markers = renderedServers.map((name) => `${name}::__configured__`)
      
      const keysToClear = [...renderedKeys, ...markers]
      const keptKeys = (item.mcpTools || []).filter((key) => !keysToClear.includes(key))
      
      item.mcpTools = [...keptKeys, ...checkedKeys, ...markers]
    }
    // Clean up tools of servers that no longer exist in the server list
    const existingServerNames = item.mcpServers.map((s) => s.name)
    item.mcpTools = (item.mcpTools || []).filter((key) => {
      const parts = key.split('::')
      return parts.length >= 2 && existingServerNames.includes(parts[0])
    })
    item.memory = inputMemory.checked
    item.toolsSearch = inputToolsSearch.checked
    const rounds = parseInt(inputMaxRounds.value, 10)
    item.maxRounds = Number.isFinite(rounds) && rounds > 0 ? rounds : 100
  }

  // 將 API 設定同步回下拉選單選擇的 AI 模型群組
  await saveCurrentFieldsToSelectedPreset(apiBaseUrl, apiKey, modelName)

  await saveItems()
  closeSettingsDialog()
  renderList()
}

// ============================================================
// 事件繫結
// ============================================================

/** 發送使用者訊息給選中的 Agent */
function sendMessageToAgent(): void {
  if (selectedItemId === null) return
  const val = agentUserInput.value.trim()
  if (!val) return

  agentUserInput.value = ''

  if (runningItems.has(selectedItemId)) {
    void invoke('send_agent_message', { itemId: selectedItemId, message: val })
    const now = Date.now()
    if (!itemLogs.has(selectedItemId)) itemLogs.set(selectedItemId, [])
    const logs = itemLogs.get(selectedItemId)!
    logs.push({
      level: 'info',
      message: `💬 使用者插話：\n${val}`,
      timestamp: now,
    })
    if (!currentSessionExchanges.has(selectedItemId)) {
      currentSessionExchanges.set(selectedItemId, [])
    }
    currentSessionExchanges.get(selectedItemId)!.push({
      round: 0,
      phase: 'user_input',
      endpoint: '',
      payload: { content: val },
      timestamp: now,
    })
    const item = items.find((candidate) => candidate.id === selectedItemId)
    if (item) scheduleLiveSessionFlush(item, 100)
    renderMessageBox(selectedItemId)
  } else {
    void runItem(selectedItemId, val)
  }
}

if (agentUserInput && btnSendMessage) {
  btnSendMessage.addEventListener('click', sendMessageToAgent)
  agentUserInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessageToAgent()
    }
  })
}

/** 新增 Agent */
btnAdd.addEventListener('click', async () => {
  const newId = nextId++
  const newItem: ListItem = {
    id: newId,
    code: itemCodeFromId(newId),
    agentId: generateAgentId(),
    name: generateDefaultItemName(),
    prompt: '',
    apiBaseUrl: '',
    apiKey: '',
    modelName: '',
    workingDirectory: '',
    tools: [],
    skills: [],
    mcpServers: [],
    mcpTools: [],
    memory: false,
    allowHttp: false,
    toolsSearch: false,
    embeddingApiBaseUrl: '',
    embeddingApiKey: '',
    embeddingModel: '',
    maxRounds: 100,
  }
  items.push(newItem)
  await saveItems()
  renderList()
})

/** 開啟事件設定 */
btnEvents.addEventListener('click', openEventsDialog)
btnCloseEvents.addEventListener('click', closeEventsDialog)
btnCloseEventsFooter.addEventListener('click', closeEventsDialog)
let eventsOverlayMousedownOnBg = false
eventsOverlay.addEventListener('mousedown', (e) => { eventsOverlayMousedownOnBg = e.target === eventsOverlay })
eventsOverlay.addEventListener('click', (e) => {
  if (e.target === eventsOverlay && eventsOverlayMousedownOnBg) closeEventsDialog()
})
selectEventRecurrence.addEventListener('change', updateRecurrenceFields)
function renderHttpAgentsList(): void {
  if (!httpAgentsList) return
  httpAgentsList.innerHTML = ''
  if (items.length === 0) {
    httpAgentsList.innerHTML = '<span class="skill-placeholder">（尚未建立任何 Agent）</span>'
    return
  }
  items.forEach((item) => {
    const label = document.createElement('label')
    label.className = 'http-agent-option'

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!item.allowHttp
    cb.addEventListener('change', async () => {
      item.allowHttp = cb.checked
      await saveItems()
      renderList()
    })

    const text = document.createElement('span')
    text.textContent = item.name

    label.append(cb, text)
    httpAgentsList.appendChild(label)
  })
}

/** 新增一次性或循環排程事件 */
btnAddEvent.addEventListener('click', async () => {
  const triggerAt = getClockTimestamp()
  const agentId = Number(selectEventAgent.value)
  if (!Number.isFinite(triggerAt) || triggerAt <= Date.now()) {
    window.alert('請選擇目前時間之後的觸發時間。')
    openClockPopup()
    return
  }
  if (!items.some((item) => item.id === agentId)) {
    window.alert('請選擇有效的 Agent。')
    return
  }

  const recurrence = selectEventRecurrence.value === 'interval' ? 'interval' : 'once'
  const intervalSeconds = recurrence === 'interval' ? getEventIntervalSeconds() : undefined

  scheduledEvents.push({
    id: crypto.randomUUID(),
    triggerAt,
    agentId,
    recurrence,
    intervalSeconds,
    executionCount: 0,
  })
  await saveScheduledEvents()
  renderScheduledEvents()
  renderList()
  setClockFromTimestamp(Date.now() + 5 * 60 * 1000)
})

/** 新增自訂事件與 Agent 訂閱關聯 */
btnAddMapping.addEventListener('click', async () => {
  const eventId = inputMappingEventId.value.trim()
  const agentId = Number(selectMappingAgent.value)
  if (!eventId) {
    window.alert('請輸入事件 ID。')
    inputMappingEventId.focus()
    return
  }
  if (!items.some((item) => item.id === agentId)) {
    window.alert('請選擇有效的 Agent。')
    return
  }

  // 防止重複訂閱相同事件與 Agent 關聯
  if (eventMappings.some((m) => m.eventId.toLowerCase() === eventId.toLowerCase() && m.agentId === agentId)) {
    window.alert('該事件訂閱已存在。')
    return
  }

  eventMappings.push({
    id: 'm_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 5),
    eventId,
    agentId,
  })
  await saveEventMappings()
  renderEventMappings()
  renderList()
  inputMappingEventId.value = ''
})

/** 關閉對話框 */
btnCloseDialog.addEventListener('click', closeSettingsDialog)
btnCancel.addEventListener('click', closeSettingsDialog)

/** 點擊 overlay 背景關閉（mousedown 必須也在背景才算，防止從對話框內拖出後誤關） */
let settingsOverlayMousedownOnBg = false
settingsOverlay.addEventListener('mousedown', (e) => { settingsOverlayMousedownOnBg = e.target === settingsOverlay })
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay && settingsOverlayMousedownOnBg) closeSettingsDialog()
})

/** 全域設定事件繫結 */
btnGlobalSettings.addEventListener('click', openGlobalSettings)
btnCloseGlobalSettings.addEventListener('click', closeGlobalSettings)
btnGlobalSettingsCancel.addEventListener('click', closeGlobalSettings)

const FONT_MIN = 10, FONT_MAX = 24
btnExecFontInc.addEventListener('click', () => { execFontSize = Math.min(FONT_MAX, execFontSize + 1); applyFontSizes() })
btnExecFontDec.addEventListener('click', () => { execFontSize = Math.max(FONT_MIN, execFontSize - 1); applyFontSizes() })
btnGlobalSettingsSave.addEventListener('click', async () => {
  await saveGlobalSettings()
  closeGlobalSettings()
})

let globalSettingsOverlayMousedownOnBg = false
globalSettingsOverlay.addEventListener('mousedown', (e) => { globalSettingsOverlayMousedownOnBg = e.target === globalSettingsOverlay })
globalSettingsOverlay.addEventListener('click', (e) => {
  if (e.target === globalSettingsOverlay && globalSettingsOverlayMousedownOnBg) closeGlobalSettings()
})

/** 手動重新取得 MCP 工具 */
document.getElementById('btn-fetch-mcp-tools')!.addEventListener('click', () => {
  const servers = getMcpServersFromUI()
  const checked = getCheckedMcpTools()
  
  const mcpToolInputs = mcpToolSectionEl.querySelectorAll<HTMLInputElement>('input[name="mcp-tool"]')
  const renderedServers = Array.from(new Set(Array.from(mcpToolInputs).map((cb) => cb.value.split('::')[0])))
  const markers = renderedServers.map((name) => `${name}::__configured__`)
  
  const current = [...checked, ...markers]
  const workingDirectory = inputWorkingDirectory.value.trim()
  fetchAndRenderMcpTools(servers, current, workingDirectory)
})

/** 新增 MCP Server 列 */
document.getElementById('btn-add-mcp')!.addEventListener('click', () => {
  const cfg: McpServerConfig = { name: '', enabled: true, transport: 'stdio', command: '', args: [], env: {}, url: '' }
  mcpServerListEl.appendChild(makeMcpRow(cfg, mcpServerListEl.children.length))
})

/** 儲存 */
btnSave.addEventListener('click', saveSettings)
btnDelete.addEventListener('click', deleteSettings)

/** 使用原生目錄選擇器設定工作目錄 */
btnSelectWorkingDirectory.addEventListener('click', async () => {
  try {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: '選擇工作目錄',
      defaultPath: inputWorkingDirectory.value.trim() || undefined,
    })
    if (typeof selected === 'string') inputWorkingDirectory.value = selected
  } catch (error) {
    console.error('開啟目錄選擇器失敗', error)
  }
})

/** 下拉選單切換群組 */
selectPreset.addEventListener('change', onPresetChange)

/** 儲存為新群組 */
btnSavePreset.addEventListener('click', saveAsPreset)

/** 鍵盤快捷鍵：Enter 儲存、Esc 關閉 */
document.addEventListener('keydown', (e) => {
  if (!eventsOverlay.classList.contains('hidden') && e.key === 'Escape') {
    e.preventDefault()
    closeEventsDialog()
    return
  }
  if (settingsOverlay.classList.contains('hidden')) return

  if (e.key === 'Escape') {
    e.preventDefault()
    closeSettingsDialog()
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    saveSettings()
  }
})

// ============================================================
// 分隔條拖曳邏輯
// ============================================================

/** 開始拖曳分隔條 */
function onSplitterMouseDown(e: MouseEvent): void {
  e.preventDefault()
  splitterDragging = true
  splitterStartY = e.clientY
  splitterStartHeight = messageBox.offsetHeight
  splitter.classList.add('active')
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

/** 拖曳分隔條中 */
function onSplitterMouseMove(e: MouseEvent): void {
  if (!splitterDragging) return

  const deltaY = splitterStartY - e.clientY // 向上拖為正值（擴大訊息框）
  const newHeight = splitterStartHeight + deltaY

  // 限制範圍：最小 48px，最大 90vh
  const maxHeight = window.innerHeight * 0.9
  const clampedHeight = Math.max(48, Math.min(maxHeight, newHeight))

  messageBox.style.height = `${clampedHeight}px`
}

/** 結束拖曳分隔條 */
function onSplitterMouseUp(): void {
  if (!splitterDragging) return

  splitterDragging = false
  splitter.classList.remove('active')
  document.body.style.cursor = ''
  document.body.style.userSelect = ''

  // 儲存使用者偏好的高度
  try {
    localStorage.setItem(SPLITTER_HEIGHT_KEY, String(messageBox.offsetHeight))
  } catch { /* 忽略 */ }
}

// 繫結水平分隔條事件
splitter.addEventListener('mousedown', onSplitterMouseDown)
document.addEventListener('mousemove', onSplitterMouseMove)
document.addEventListener('mouseup', onSplitterMouseUp)

// ============================================================
// 垂直分隔條拖曳邏輯
// ============================================================

function onVSplitterMouseDown(e: MouseEvent): void {
  e.preventDefault()
  vsplitterDragging = true
  vsplitterStartX = e.clientX
  vsplitterStartWidth = sessionHistoryPanel.offsetWidth
  vsplitter.classList.add('active')
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onVSplitterMouseMove(e: MouseEvent): void {
  if (!vsplitterDragging) return
  const deltaX = e.clientX - vsplitterStartX
  const newWidth = vsplitterStartWidth + deltaX
  const maxWidth = messageBox.offsetWidth * 0.5
  const clamped = Math.max(80, Math.min(maxWidth, newWidth))
  sessionHistoryPanel.style.width = `${clamped}px`
}

function onVSplitterMouseUp(): void {
  if (!vsplitterDragging) return
  vsplitterDragging = false
  vsplitter.classList.remove('active')
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  try {
    localStorage.setItem(VSPLITTER_WIDTH_KEY, String(sessionHistoryPanel.offsetWidth))
  } catch { /* 忽略 */ }
}

vsplitter.addEventListener('mousedown', onVSplitterMouseDown)
document.addEventListener('mousemove', onVSplitterMouseMove)
document.addEventListener('mouseup', onVSplitterMouseUp)

// ============================================================
// 簡化／詳細切換
// ============================================================

btnViewToggle.addEventListener('click', () => {
  viewDetailed = !viewDetailed
  updateViewToggleUI()
  if (viewingSessionData) {
    renderSessionViewInPanel(viewingSessionData)
  } else if (selectedItemId !== null) {
    renderMessageBox(selectedItemId)
  }
})

// ============================================================
// 卡片／列表檢視切換
// ============================================================

btnListViewToggle.addEventListener('click', () => {
  listViewMode = listViewMode === 'card' ? 'list' : 'card'
  updateListViewToggleUI()
  try { localStorage.setItem(VIEW_MODE_KEY, listViewMode) } catch { /* ignore */ }
  renderList()
})

// ============================================================
// 主題切換 (Design Variations / Theme Switching)
// ============================================================

const THEME_KEY = 'listagent_theme'
const selectTheme = document.getElementById('select-theme') as HTMLSelectElement | null

function applyTheme(theme: string) {
  document.body.classList.remove(
    'theme-glass-neon',
    'theme-cherry-blossom',
    'theme-cyberpunk-amber',
    'theme-midnight-forest',
    'theme-ocean-breeze',
    'theme-solarized-light',
    'theme-nordic-slate',
    'theme-sunset-blvd',
    'theme-royal-velvet',
    'theme-minimalist-ink',
    'theme-vaporwave'
  )
  if (theme && theme !== 'default') {
    document.body.classList.add(`theme-${theme}`)
  }
}

if (selectTheme) {
  const savedTheme = localStorage.getItem(THEME_KEY) || 'default'
  selectTheme.value = savedTheme
  applyTheme(savedTheme)

  selectTheme.addEventListener('change', () => {
    const selected = selectTheme.value
    applyTheme(selected)
    localStorage.setItem(THEME_KEY, selected)
  })
}

// ============================================================
// 初始化
// ============================================================

;(async () => {
  // 從 localStorage / Tauri 還原先前儲存的項目與全域設定
  items = await loadItems()
  await loadGlobalSettings()
  // enableHttpInput initialization removed
  eventMappings = await loadEventMappings()
  scheduledEvents = (await loadScheduledEvents())
    .filter((event) => typeof event.id === 'string'
      && Number.isFinite(event.triggerAt)
      && Number.isInteger(event.agentId))
    .map((event) => {
      const recurring = event.recurrence === 'interval'
        && Number.isFinite(event.intervalSeconds)
        && (event.intervalSeconds ?? 0) >= 60
      return {
        ...event,
        recurrence: recurring ? 'interval' as const : 'once' as const,
        intervalSeconds: recurring ? event.intervalSeconds : undefined,
        executedAt: Number.isFinite(event.executedAt) ? event.executedAt : undefined,
        executionCount: Number.isInteger(event.executionCount) && event.executionCount >= 0
          ? event.executionCount
          : event.executedAt ? 1 : 0,
      }
    })
    .sort((a, b) => a.triggerAt - b.triggerAt)
  ensureUniqueItemNames(items)
  const savedNextId = localStorage.getItem(STORAGE_KEY_NEXT_ID)
  if (savedNextId) {
    nextId = parseInt(savedNextId, 10) || 1
  } else if (items.length > 0) {
    // 從既有項目推導 nextId（處理 Tauri 情境無 localStorage 的情況）
    nextId = Math.max(...items.map((i) => i.id)) + 1
  }

  // 統一重寫持久化格式，移除舊版 settings.json / localStorage 的 code 欄位
  await saveItems()
  await saveScheduledEvents()

  if (isTauri()) {
    await listen<ModelExchangeEvent>('model-exchange', (event) => {
      recordModelExchange(event.payload)
    })
    await listen('http-input-available', () => {
      void drainHttpInputs()
    })
    await listen<{ eventId: string; message: string; arg1: string; arg2: string; arg3: string }>('agent-event-triggered', (event) => {
      handleAgentEvent(
        event.payload.eventId,
        event.payload.message,
        event.payload.arg1,
        event.payload.arg2,
        event.payload.arg3
      )
    })
    await drainHttpInputs()
  }

  // 還原使用者偏好的訊息框高度
  const savedHeight = localStorage.getItem(SPLITTER_HEIGHT_KEY)
  if (savedHeight) {
    const h = parseInt(savedHeight, 10)
    if (!isNaN(h) && h >= 48 && h <= window.innerHeight * 0.9) {
      messageBox.style.height = `${h}px`
    }
  }

  // 還原使用者偏好的垂直分隔條位置
  const savedVWidth = localStorage.getItem(VSPLITTER_WIDTH_KEY)
  if (savedVWidth) {
    const w = parseInt(savedVWidth, 10)
    if (!isNaN(w) && w >= 80) {
      sessionHistoryPanel.style.width = `${w}px`
    }
  }

  // 還原使用者偏好的檢視模式
  try {
    const saved = localStorage.getItem(VIEW_MODE_KEY)
    if (saved === 'card' || saved === 'list') listViewMode = saved
  } catch { /* ignore */ }

  updateViewToggleUI()
  updateListViewToggleUI()
  renderList()
  renderScheduledEvents()
  updateInputBoxState()
  await checkScheduledEventTriggers()
  window.setInterval(() => void checkScheduledEventTriggers(), 1000)
})()
