import re

with open(r'D:\Source\ListAgent\listagent-app\src-tauri\src\lib.rs', 'r', encoding='utf-8') as f:
    content = f.read()

# Change 1: enhance ensure_inside_workspace error message
old_ensure = '''fn ensure_inside_workspace(root: &Path, path: PathBuf) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("路徑不存在或無法存取：{error}"))?;
    if !canonical.starts_with(root) {
        return Err("拒絕存取工具工作目錄以外的路徑".to_string());
    }
    Ok(canonical)
}'''

new_ensure = '''fn ensure_inside_workspace(root: &Path, path: PathBuf) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| {
            format!(
                "路徑不存在或無法存取：{error}\n\n\
                提示：\n\
                - 工作目錄為「{}」\n\
                - 嘗試存取的完整路徑為「{}」\n\
                - 請先用 list_directory 查看工作目錄下有哪些檔案與資料夾，確認正確的路徑後再重試。",
                root.display(),
                path.display()
            )
        })?;
    if !canonical.starts_with(root) {
        return Err(format!(
            "拒絕存取工具工作目錄以外的路徑。\n工作目錄：「{}」\n嘗試存取：「{}」\n提示：請只存取工作目錄下的路徑。",
            root.display(),
            canonical.display()
        ));
    }
    Ok(canonical)
}'''

if old_ensure in content:
    content = content.replace(old_ensure, new_ensure)
    print("ensure_inside_workspace replaced successfully")
else:
    print("ensure_inside_workspace NOT FOUND - trying different match")
    # Try finding the function signature
    idx = content.find('fn ensure_inside_workspace')
    if idx >= 0:
        print(f"Found at index {idx}")
        print(repr(content[idx:idx+300]))
    else:
        print("NOT FOUND AT ALL")

# Change 2: enhance resolve_existing_tool_path error message
old_resolve = '''fn resolve_existing_tool_path(root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw_path);
    ensure_inside_workspace(
        root,
        if path.is_absolute() {
            path.into()
        } else {
            root.join(path)
        },
    )
}'''

new_resolve = '''fn resolve_existing_tool_path(root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw_path);
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let display_full = full.display().to_string();
    ensure_inside_workspace(root, full)
        .map_err(|e| format!("{e}\n傳入路徑：\"{raw_path}\"（完整路徑：\"{display_full}\"）"))
}'''

if old_resolve in content:
    content = content.replace(old_resolve, new_resolve)
    print("resolve_existing_tool_path replaced successfully")
else:
    print("resolve_existing_tool_path NOT FOUND")

# Change 3: enhance system prompt with tool failure recovery instructions
old_system_prompt = '''            "You are a tool-using coding agent.\\n\\\n{now_line}\\n\\\n{workspace_line}\\n\\\nFor build/run/test/execute/fix/verify requests, actually use tools unless the user asks only for instructions.\\n\\\nKnown scripts/commands such as build.bat: run directly with execute_command from workspace root; do not use search_content to find filenames.\\n\\\nFor long builds, set timeout_seconds 1800-7200.\\n\\\nFollow tool next_step. When the requested task succeeds, stop calling tools and give the final result."'''

new_system_prompt = '''            "You are a tool-using coding agent.\\n\\\n{now_line}\\n\\\n{workspace_line}\\n\\\nFor build/run/test/execute/fix/verify requests, actually use tools unless the user asks only for instructions.\\n\\\nKnown scripts/commands such as build.bat: run directly with execute_command from workspace root; do not use search_content to find filenames.\\n\\\nFor long builds, set timeout_seconds 1800-7200.\\n\\\nFollow tool next_step. When the requested task succeeds, stop calling tools and give the final result.\\n\\\nIMPORTANT — Tool failure recovery:\\n- If a path tool (grep_search, search_content, read_file, list_directory, replace_string) fails because a path does not exist, DO NOT give up. Instead, call list_directory with path \\".\\" to explore the workspace, find the correct directory name, and retry with the correct path.\\n- If list_directory itself fails with \\".\\", try calling it without arguments.\\n- Always try at least one recovery attempt before concluding a task cannot be done."'''

if old_system_prompt in content:
    content = content.replace(old_system_prompt, new_system_prompt)
    print("system prompt replaced successfully")
else:
    print("system prompt NOT FOUND - trying to locate")
    idx = content.find("You are a tool-using coding agent")
    if idx >= 0:
        print(f"Found at index {idx}")
        print(repr(content[idx:idx+500]))
    else:
        print("NOT FOUND AT ALL")

# Write back
with open(r'D:\Source\ListAgent\listagent-app\src-tauri\src\lib.rs', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done writing file")
