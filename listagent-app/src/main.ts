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
  parameters: unknown
}

interface EventMapping {
  id: string
  eventId: string
  agentId: number
}

type ToolName = 'list_directory' | 'search_content' | 'read_file' | 'write_file' | 'replace_string' | 'trigger_event'

const TOOL_NAMES: ToolName[] = ['list_directory', 'search_content', 'read_file', 'write_file', 'replace_string', 'trigger_event']

interface AgentExecutionResult {
  endpoint: string
  content: string
  stats?: unknown
}

interface ModelExchangeEvent {
  itemId: number
  round: number
  phase: 'request' | 'response' | 'tool' | 'error'
  endpoint: string
  payload: unknown
}

interface SessionExchange {
  round: number
  phase: 'request' | 'response' | 'tool' | 'error'
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
const STORAGE_KEY_ENABLE_HTTP = 'listagent_enable_http'
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
let enableHttpInput = true
let eventMappings: EventMapping[] = []

/** 由持久化 id 確定性產生 4 碼顯示代碼，不需另存 code 欄位 */
function itemCodeFromId(id: number): string {
  const code = id.toString(36).toUpperCase()
  if (code.length > 4) throw new Error('item id 已超出 4 碼代碼可表示的範圍')
  return code.padStart(4, '0')
}

function hydrateItems(storedItems: PersistedListItem[]): ListItem[] {
  return storedItems.map((item) => ({
    ...item,
    code: itemCodeFromId(item.id),
    workingDirectory: typeof item.workingDirectory === 'string' ? item.workingDirectory : '',
    tools: Array.isArray(item.tools)
      ? item.tools.filter((tool): tool is ToolName => TOOL_NAMES.includes(tool as ToolName))
      : [],
    skills: Array.isArray(item.skills) ? item.skills.filter((s): s is string => typeof s === 'string') : [],
    mcpServers: Array.isArray(item.mcpServers) ? item.mcpServers : [],
    mcpTools: Array.isArray(item.mcpTools) ? item.mcpTools : [],
    memory: typeof item.memory === 'boolean' ? item.memory : false,
  }))
}

function getPersistedItems(): PersistedListItem[] {
  return items.map((item) => ({
    id: item.id,
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

/** 右側面板目前正在查看的歷史 session（null = 即時執行過程） */
let viewingSessionData: SessionData | null = null

/** 目前已載入的歷史 session 清單 */
let loadedSessions: SessionFileMeta[] = []

/** 目前正在查看的 session 路徑 */
let viewingSessionPath: string | null = null

/** 目前正在等待模型回應的 item */
const runningItems = new Set<number>()

interface QueuedTask {
  parameters?: unknown
  enqueuedAt: number
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
  const payload = JSON.stringify(exchange.payload, null, 2)
  const phaseLabels = {
    request: '→ 發送給 AI Model',
    response: '← AI Model 回應',
    tool: '⚙ Tool 執行',
    error: '✖ AI Model 錯誤',
  } as const
  const levels: Record<ModelExchangeEvent['phase'], LogLevel> = {
    request: 'info',
    response: 'success',
    tool: 'system',
    error: 'error',
  }
  const now = Date.now()
  logs.push({
    level: levels[exchange.phase],
    message: `[AI Round ${exchange.round}] ${phaseLabels[exchange.phase]}\nEndpoint：${exchange.endpoint}\n${payload}`,
    timestamp: now,
    kind: 'detail',
  })
  const simpleEntry = makeSimpleExchangeEntry(exchange.phase, exchange.round, exchange.payload, now)
  if (simpleEntry) logs.push(simpleEntry)

  // 同步紀錄到 session exchanges
  if (!currentSessionExchanges.has(exchange.itemId)) {
    currentSessionExchanges.set(exchange.itemId, [])
  }
  currentSessionExchanges.get(exchange.itemId)!.push({
    round: exchange.round,
    phase: exchange.phase,
    endpoint: exchange.endpoint,
    payload: exchange.payload,
    timestamp: now,
  })

  if (selectedItemId === exchange.itemId && viewingSessionData === null) {
    renderMessageBox(exchange.itemId)
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
const inputPrompt = document.getElementById('input-prompt') as HTMLTextAreaElement
const inputApiBaseUrl = document.getElementById('input-api-base-url') as HTMLInputElement
const inputApiKey = document.getElementById('input-api-key') as HTMLInputElement
const inputModelName = document.getElementById('input-model-name') as HTMLInputElement
const inputWorkingDirectory = document.getElementById('input-working-directory') as HTMLInputElement
const btnSelectWorkingDirectory = document.getElementById('btn-select-working-directory') as HTMLButtonElement
const toolCheckboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="agent-tool"]'))
const inputMemory = document.getElementById('input-memory') as HTMLInputElement
const skillListEl = document.getElementById('skill-list') as HTMLElement
const selectPreset = document.getElementById('select-preset') as HTMLSelectElement
const btnSavePreset = document.getElementById('btn-save-preset') as HTMLButtonElement
const btnSave = document.getElementById('btn-save') as HTMLButtonElement
const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement

// 排程事件視窗元素
const eventsOverlay = document.getElementById('events-overlay') as HTMLElement
const btnCloseEvents = document.getElementById('btn-close-events') as HTMLButtonElement
const btnCloseEventsFooter = document.getElementById('btn-close-events-footer') as HTMLButtonElement
const inputEventTime = document.getElementById('input-event-time') as HTMLInputElement
const selectEventAgent = document.getElementById('select-event-agent') as HTMLSelectElement
const selectEventRecurrence = document.getElementById('select-event-recurrence') as HTMLSelectElement
const eventIntervalFields = document.getElementById('event-interval-fields') as HTMLElement
const inputEventInterval = document.getElementById('input-event-interval') as HTMLInputElement
const selectEventIntervalUnit = document.getElementById('select-event-interval-unit') as HTMLSelectElement
const btnAddEvent = document.getElementById('btn-add-event') as HTMLButtonElement
const eventsList = document.getElementById('events-list') as HTMLElement
const inputEnableHttp = document.getElementById('input-enable-http') as HTMLInputElement
const inputMappingEventId = document.getElementById('input-mapping-event-id') as HTMLInputElement
const selectMappingAgent = document.getElementById('select-mapping-agent') as HTMLSelectElement
const btnAddMapping = document.getElementById('btn-add-mapping') as HTMLButtonElement
const eventMappingsList = document.getElementById('event-mappings-list') as HTMLElement

// 訊息框元素
const msgContent = document.getElementById('message-content') as HTMLElement
const msgItemName = document.getElementById('msg-item-name') as HTMLElement
const msgPanelTitle = document.getElementById('msg-panel-title') as HTMLElement
const sessionListEl = document.getElementById('session-list') as HTMLElement

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

  items.forEach((item) => {
    const card = createItemCard(item)
    listContainer.appendChild(card)
  })
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

  // 最左側：固定且唯一的 item 代碼
  const codeEl = document.createElement('span')
  codeEl.className = 'item-code'
  codeEl.textContent = item.code
  codeEl.title = `Agent ID：${item.code}`

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

  // 執行按鈕
  const runBtn = document.createElement('button')
  runBtn.className = 'btn-run'
  if (runningItems.has(item.id)) {
    const queuedCount = itemTaskQueues.get(item.id)?.length ?? 0
    runBtn.innerHTML = '⏳'
    runBtn.title = queuedCount > 0 ? `等待模型回應（Queue：${queuedCount}）` : '等待模型回應'
    runBtn.classList.add('running')
    runBtn.disabled = true
  } else {
    runBtn.innerHTML = '▶️'
    runBtn.title = '執行'
  }
  runBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!runningItems.has(item.id)) void runItem(item.id)
  })

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

  if (itemEvents.length > 0) card.appendChild(eventIcon)
  card.appendChild(codeEl)
  card.appendChild(info)
  card.appendChild(runBtn)
  card.appendChild(gearBtn)

  return card
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
  document.querySelectorAll('.item-card').forEach((card) => {
    const cardId = Number((card as HTMLElement).dataset.id)
    if (cardId === id) {
      card.classList.add('selected')
    } else {
      card.classList.remove('selected')
    }
  })

  renderMessageBox(id)
  void loadAndRenderSessions(item)
}

/** 呼叫指定 item 設定的模型 API */
async function runItem(id: number, parameters?: unknown): Promise<void> {
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
      queue.push({ parameters, enqueuedAt: Date.now() })
      itemTaskQueues.set(id, queue)
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

  // 若目前選取的是此 item 且在即時模式，立即更新訊息框
  if (selectedItemId === id && viewingSessionData === null) {
    renderMessageBox(id)
  }

  runningItems.add(id)
  updateCardRunButton(id, true)

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
      },
    })
    logs.push({ level: 'success', message: `模型端點：${result.endpoint}`, timestamp: Date.now() })
    logs.push({ level: 'system', message: result.content, timestamp: Date.now() + 1 })
    if (result.stats) {
      logs.push({ level: 'info', message: `用量：${JSON.stringify(result.stats)}`, timestamp: Date.now() + 2 })
    }
  } catch (error) {
    logs.push({ level: 'error', message: `模型請求失敗：${String(error)}`, timestamp: Date.now() })
  } finally {
    logs.push({ level: 'system', message: `══════ Agent「${item.name}」執行結束 ══════`, timestamp: Date.now() })
    runningItems.delete(id)
    updateCardRunButton(id, false)
    if (selectedItemId === id && viewingSessionData === null) renderMessageBox(id)

    // 儲存本次 session
    void saveCurrentSession(item)

    const queue = itemTaskQueues.get(id)
    const nextTask = queue?.shift()
    if (queue && queue.length === 0) itemTaskQueues.delete(id)
    if (nextTask) {
      logs.push({
        level: 'system',
        message: `從 Queue 取出下一項任務（已等待 ${Math.max(0, Math.round((Date.now() - nextTask.enqueuedAt) / 1000))} 秒，剩餘 ${queue?.length ?? 0} 項）`,
        timestamp: Date.now(),
      })
      if (selectedItemId === id && viewingSessionData === null) renderMessageBox(id)
      void runItem(id, nextTask.parameters)
    }
  }
}

/** 取出 HTTP server 收到的輸入，依項目名稱分派 */
async function drainHttpInputs(): Promise<void> {
  if (!isTauri()) return

  try {
    const pending = await invoke<HttpInput[]>('take_http_inputs')
    pending.forEach((input) => {
      const item = items.find((candidate) => itemNameKey(candidate.name) === itemNameKey(input.agent))
      if (!item) {
        console.warn(`找不到名稱為「${input.agent}」的項目`)
        return
      }
      void runItem(item.id, input.parameters)
    })
  } catch (error) {
    console.error('讀取 HTTP 輸入失敗', error)
  }
}

/** 更新卡片上的執行狀態 */
function updateCardRunButton(id: number, running: boolean): void {
  const card = document.querySelector(`.item-card[data-id="${id}"]`) as HTMLElement | null
  if (!card) return

  const btn = card.querySelector('.btn-run') as HTMLButtonElement | null
  if (!btn) return

  if (running) {
    const queuedCount = itemTaskQueues.get(id)?.length ?? 0
    btn.innerHTML = '⏳'
    btn.title = queuedCount > 0 ? `等待模型回應（Queue：${queuedCount}）` : '等待模型回應'
    btn.classList.add('running')
    btn.disabled = true
    card.classList.add('has-running-agent')
  } else {
    btn.innerHTML = '▶️'
    btn.title = '執行'
    btn.classList.remove('running')
    btn.disabled = false
    card.classList.remove('has-running-agent')
  }
}

/** 渲染訊息框內容（即時執行過程） */
function renderMessageBox(itemId: number): void {
  const item = items.find((i) => i.id === itemId)
  if (!item) {
    msgContent.innerHTML = '<span class="message-placeholder">← 點擊任一項目以查看執行過程</span>'
    msgItemName.textContent = ''
    msgPanelTitle.textContent = '📋 執行過程'
    return
  }

  msgPanelTitle.textContent = '📋 執行過程'
  msgItemName.textContent = item.name

  const logs = itemLogs.get(itemId)
  if (!logs || logs.length === 0) {
    msgContent.innerHTML = '<span class="message-placeholder">尚無執行記錄</span>'
    return
  }

  msgContent.innerHTML = logsToHtml(logs)

  // 自動捲到最底部
  msgContent.scrollTop = msgContent.scrollHeight
}

/** 更新切換按鈕的視覺狀態 */
function updateViewToggleUI(): void {
  btnViewToggle.textContent = viewDetailed ? '詳細' : '簡化'
}

const SIMPLE_TRUNCATE_LIMIT = 600

function truncateForSimple(text: string): string {
  if (text.length <= SIMPLE_TRUNCATE_LIMIT) return text
  return text.slice(0, SIMPLE_TRUNCATE_LIMIT) + `\n…（已截斷，共 ${text.length} 字）`
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
      const message = viewDetailed ? entry.message : truncateForSimple(entry.message)
      return `<div class="log-line log-${entry.level}">[${time}] ${escapeHtml(message)}</div>`
    })
    .join('')
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
      const toolCalls = msg?.tool_calls as unknown[] | undefined
      let text: string
      if (toolCalls && toolCalls.length > 0) {
        const names = toolCalls
          .map((tc) => ((tc as Record<string, unknown>)?.function as Record<string, unknown> | undefined)?.name ?? '?')
          .join(', ')
        text = `🤖 AI 決定呼叫工具：${names}`
      } else if (content.trim()) {
        text = `🤖 AI 回覆：\n${content}`
      } else {
        return null
      }
      return { level: 'success', message: text, timestamp, kind: 'simple' }
    }
    case 'tool': {
      const name = (p.name as string) ?? '?'
      const result = (p.result as string) ?? ''
      return { level: 'system', message: `🔧 工具 ${name} 結果：\n${result}`, timestamp, kind: 'simple' }
    }
    case 'error': {
      const message = (p.message as string) ?? String(payload)
      return { level: 'error', message: `✖ AI 模型錯誤：${message}`, timestamp, kind: 'simple' }
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

/** 儲存本次執行的 session 到檔案 */
async function saveCurrentSession(item: ListItem): Promise<void> {
  if (!isTauri()) return
  const exchanges = currentSessionExchanges.get(item.id)
  if (!exchanges || exchanges.length === 0) return

  const startedAt = currentSessionStartedAt.get(item.id) ?? Date.now()
  const endedAt = Date.now()
  const now = new Date(endedAt)
  const sessionId = `session_${formatSessionTimestamp(now)}`

  const session: SessionData = {
    sessionId,
    startedAt,
    endedAt,
    itemId: item.id,
    itemName: item.name,
    modelName: item.modelName,
    apiBaseUrl: item.apiBaseUrl,
    exchanges,
  }

  try {
    await invoke('save_session', {
      workingDirectory: item.workingDirectory,
      subdir: item.code,
      filename: `${sessionId}.json`,
      content: JSON.stringify(session, null, 2),
    })

    // 若目前選取的是此 item，刷新歷史清單
    if (selectedItemId === item.id) {
      await loadAndRenderSessions(item)
    }
  } catch (error) {
    console.error('儲存 session 失敗', error)
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
  }
  const levelMap: Record<string, string> = {
    request: 'info',
    response: 'success',
    tool: 'system',
    error: 'error',
  }

  const logs: LogEntry[] = session.exchanges.flatMap((ex) => {
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
    return simpleEntry ? [detailEntry, simpleEntry] : [detailEntry]
  })

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
      await invoke('write_settings', { settings })
    } catch { /* Tauri 失敗時至少已存 localStorage */ }
  }
}

async function loadEnableHttp(): Promise<boolean> {
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      if (typeof settings.enableHttpInput === 'boolean') {
        return settings.enableHttpInput
      }
    } catch { /* Fallback */ }
  }
  const raw = localStorage.getItem(STORAGE_KEY_ENABLE_HTTP)
  return raw === null ? true : raw === 'true'
}

async function saveEnableHttp(val: boolean): Promise<void> {
  enableHttpInput = val
  localStorage.setItem(STORAGE_KEY_ENABLE_HTTP, String(val))
  if (isTauri()) {
    try {
      const settings: SettingsFile = await invoke('read_settings')
      settings.enableHttpInput = val
      await invoke('write_settings', { settings })
    } catch { /* Fallback */ }
  }
}

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
      await invoke('write_settings', { settings })
    } catch { /* Fallback */ }
  }
}

function renderEventMappings(): void {
  eventMappingsList.innerHTML = ''
  if (eventMappings.length === 0) {
    eventMappingsList.innerHTML = '<span class="session-placeholder">（尚未有任何事件訂閱）</span>'
    return
  }
  eventMappings.forEach((mapping) => {
    const row = document.createElement('div')
    row.className = 'event-mapping-row'

    const badge = document.createElement('span')
    badge.className = 'event-mapping-id-badge'
    badge.textContent = mapping.eventId

    const agentName = document.createElement('span')
    agentName.className = 'event-mapping-agent-name'
    const agent = items.find((i) => i.id === mapping.agentId)
    agentName.textContent = `→ 執行 Agent：${agent ? agent.name : '（未知的 Agent）'}`

    const removeBtn = document.createElement('button')
    removeBtn.className = 'btn btn-danger btn-small'
    removeBtn.style.padding = '2px 8px'
    removeBtn.textContent = '移除'
    removeBtn.addEventListener('click', async () => {
      eventMappings = eventMappings.filter((m) => m.id !== mapping.id)
      await saveEventMappings()
      renderEventMappings()
    })

    row.append(badge, agentName, removeBtn)
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

function toDatetimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp)
  const part = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`
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
  inputEventTime.value = toDatetimeLocalValue(Date.now() + 5 * 60 * 1000)
  selectEventRecurrence.value = 'once'
  inputEventInterval.value = '1'
  selectEventIntervalUnit.value = 'minutes'
  inputEnableHttp.checked = enableHttpInput
  inputMappingEventId.value = ''
  updateRecurrenceFields()
  renderScheduledEvents()
  renderEventMappings()
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
    skillListEl.innerHTML = '<span class="skill-placeholder">（尚無 Skill 檔案，請在 ~/.listagent/skills/ 目錄下新增 .md 檔案）</span>'
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

  const updateVisibility = () => {
    const isStdio = transportSel.value === 'stdio'
    commandInput.style.display = isStdio ? '' : 'none'
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

  row.append(enabledCb, nameInput, transportSel, commandInput, urlInput, delBtn)
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
    return {
      name: row.querySelector<HTMLInputElement>('.mcp-name')!.value.trim(),
      enabled: row.querySelector<HTMLInputElement>('.mcp-enabled')!.checked,
      transport,
      command: command ?? '',
      args,
      env: {},
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

  const useAll = selectedMcpTools.length === 0
  mcpToolSectionEl.innerHTML =
    '<div class="mcp-tool-divider">— MCP 工具 —</div>' +
    allTools
      .map(({ serverName, toolName, description }) => {
        const key = `${serverName}::${toolName}`
        const checked = useAll || selectedMcpTools.includes(key)
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
  inputPrompt.value = item.prompt
  inputApiBaseUrl.value = item.apiBaseUrl
  inputApiKey.value = item.apiKey
  inputModelName.value = item.modelName
  inputWorkingDirectory.value = item.workingDirectory
  toolCheckboxes.forEach((checkbox) => {
    checkbox.checked = item.tools.includes(checkbox.value as ToolName)
  })
  inputMemory.checked = item.memory

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
    window.alert(`項目名稱「${name}」已存在，請使用不同名稱。`)
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
    if (mcpToolInputs.length > 0) item.mcpTools = getCheckedMcpTools()
    item.memory = inputMemory.checked
  }

  await saveItems()
  closeSettingsDialog()
  renderList()
}

// ============================================================
// 事件繫結
// ============================================================

/** 新增項目 */
btnAdd.addEventListener('click', async () => {
  const newId = nextId++
  const newItem: ListItem = {
    id: newId,
    code: itemCodeFromId(newId),
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
inputEnableHttp.addEventListener('change', () => {
  void saveEnableHttp(inputEnableHttp.checked)
})

/** 新增一次性或循環排程事件 */
btnAddEvent.addEventListener('click', async () => {
  const triggerAt = new Date(inputEventTime.value).getTime()
  const agentId = Number(selectEventAgent.value)
  if (!Number.isFinite(triggerAt) || triggerAt <= Date.now()) {
    window.alert('請選擇目前時間之後的觸發時間。')
    inputEventTime.focus()
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
  inputEventTime.value = toDatetimeLocalValue(Date.now() + 5 * 60 * 1000)
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

/** 手動重新取得 MCP 工具 */
document.getElementById('btn-fetch-mcp-tools')!.addEventListener('click', () => {
  const servers = getMcpServersFromUI()
  const current = getCheckedMcpTools()
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

  // 限制範圍：最小 48px，最大 70vh
  const maxHeight = window.innerHeight * 0.7
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
// 初始化
// ============================================================

;(async () => {
  // 從 localStorage / Tauri 還原先前儲存的項目
  items = await loadItems()
  enableHttpInput = await loadEnableHttp()
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
    if (!isNaN(h) && h >= 48 && h <= window.innerHeight * 0.7) {
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

  updateViewToggleUI()
  renderList()
  renderScheduledEvents()
  await checkScheduledEventTriggers()
  window.setInterval(() => void checkScheduledEventTriggers(), 1000)
})()
