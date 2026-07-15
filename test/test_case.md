# ListAgent 測試套件運作機制 (Test Suite Workflow)

本文件說明 `test_case.html` 如何與 ListAgent 的本機 HTTP API 進行溝通、發送任務以及獲取執行結果。

---

## 1. 如何發送 Prompt 給 ListAgent？

`test_case.html` 會為每一次的測試產生一個唯一的執行 ID (`exec_id`)，並向 ListAgent 的本機伺服器發送 `POST` 請求：

- **API 節點**: `http://127.0.0.1:37123/input`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`
- **Payload 結構**:
  ```json
  {
    "agent_id": "你的AgentID",
    "action": "run",
    "exec_id": "tc_171999_a1b2", // 網頁端生成的唯一隨機 ID
    "tools": ["execute_command"], // 此測試案例要求的工具 (可為空陣列)
    "model": "gpt-4o", // 此測試案例要求的模型 (可為空，代表使用預設)
    "parameters": {
      "message": "測試用的 Prompt 內容"
    }
  }
  ```

### 運作行為：
- 由於 Agent 執行屬於非同步作業（需要花時間生成文字或執行工具），ListAgent 接收到請求後會立即回應 `202 Accepted`：
  ```json
  {
    "accepted": true,
    "agent": "Agent 名稱",
    "agentId": "你的AgentID",
    "action": "run"
  }
  ```
- 此時 Agent 開始在後台背景執行，網頁端則開始進行狀態輪詢。

---

## 2. 如何從 ListAgent 獲取結果？

因為執行過程是非同步的，`test_case.html` 會設定定時器（每 1 秒），定時向伺服器發送狀態查詢：

- **狀態查詢 API**: `GET http://127.0.0.1:37123/input?action=get_status&agent_id=你的AgentID`
- **狀態判定邏輯**:
  - **執行中 (Running)**：
    如果 API 回傳的 `running` 為 `true`，且 `detail.currentExecId` 等於我們先前發送的 `exec_id`，則代表該任務仍在後台執行中。
  - **完成 (Finished)**：
    當 `running` 變為 `false`，且 `detail.lastExecId` 等於我們的 `exec_id` 時，代表該任務已順利結束。

### 獲取數據與驗證：
當判定任務結束時，網頁端會執行以下步驟：

1. **讀取回答預覽**：
   直接從 `detail.lastContentPreview` 欄位取得 Agent 最終回應的文字。
2. **讀取完整 Session 歷程**：
   如果 `detail.lastSessionUrl` 存在，網頁端會再發送一個 `GET` 請求取得該 JSON 檔案。該 JSON 內包含所有工具的執行詳情（`exchanges` 陣列）以及系統日誌（`logs` 陣列）。
3. **執行驗證檢查**：
   根據 `test_case.json` 中設定的 `check` 條件（JavaScript 表達式），將上述取得的文字與歷程代入驗證：
   - 變數 `result`：對應 Agent 的最終回覆。
   - 變數 `session`：對應完整的 Session 物件。
   - 執行 `new Function` 驗證結果。
