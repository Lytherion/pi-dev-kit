# Simple Permissions for Pi

[English](#english) | [中文](#中文)

<a name="english"></a>
## English

A permission management extension for Pi Coding Agent, providing operation admission control and sandboxed Bash execution.

### Key Features

- **Three Operation Modes** (starts in `Auto` when the session has no saved selection):
  - `Default`: All sensitive operations (file writes, Bash execution) require manual user confirmation.
  - `Auto`: File writes within the current project directory and `/tmp` are allowed automatically. Bash commands run in a `bwrap` sandbox (restricted write access). Mutating Git commands or permission escalations still require confirmation.
  - `YOLO` (Unrestricted): Fully unrestricted. No sandboxing, no confirmation prompts. Like Pi with no security policy.
- **Security Sandbox**: Bash execution isolation based on `bubblewrap` (bwrap) to prevent accidental modification of critical system paths.
- **Dynamic Control**: Supports real-time mode switching via commands or shortcuts.
- **State Persistence**: Your mode selection is automatically saved within the session.

### Installation

```bash
pi install npm:pi-simple-permissions
```

Or from source:
```bash
pi install git:github.com/Lytherion/pi-simple-permissions
```

### Usage Guide

#### Commands
- `/permission`: Open the mode selection menu.
- `/permission [default|auto|yolo]`: Switch to a specific mode.

#### Shortcuts
- `Alt + M`: Cycle through permission modes (Default -> Auto -> YOLO).

#### Security Tips
In `Auto` mode, if the LLM needs to perform actions outside the sandbox, it will request escalation via `sandbox_permissions="require_escalated"`. You can decide whether to allow it based on the provided `escalation_reason`.

---

<a name="中文"></a>
## 中文

这是一个为 Pi Coding Agent 设计的权限管理扩展，提供了操作准入控制和基于沙箱的 Bash 执行环境。

### 核心特性

- **三种工作模式**（会话没有已保存选项时默认使用 `Auto`）：
  - `Default` (确认)：所有敏感操作（写文件、执行 Bash）都需要用户手动确认。
  - `Auto` (自动)：在当前项目目录和 `/tmp` 下的写操作自动允许；Bash 命令在 `bwrap` 沙箱中执行（限制写权限）；修改 Git 或越权操作需确认。
  - `YOLO` (不限)：完全放开限制。不再使用沙箱，不再弹出任何确认框。
- **安全沙箱**：基于 `bubblewrap` (bwrap) 实现的 Bash 执行隔离，防止意外修改系统关键路径。
- **动态控制**：支持实时切换模式和快捷键操作。
- **状态持久化**：模式选择会自动保存到 Session 中。

### 安装方式

```bash
pi install npm:pi-simple-permissions
```

或者从源码安装：
```bash
pi install git:github.com/Lytherion/pi-simple-permissions
```

### 使用指南

#### 命令
- `/permission`：打开模式选择菜单。
- `/permission [default|auto|yolo]`：切换到指定模式。

#### 快捷键
- `Alt + M`：在 Default -> Auto -> YOLO 模式之间循环切换。

#### 安全提示
在 `Auto` 模式下，如果 LLM 需要执行超出沙箱权限的操作，它会通过 `sandbox_permissions="require_escalated"` 向您申请提权，您可以根据其提供的 `escalation_reason` 决定是否允许。
