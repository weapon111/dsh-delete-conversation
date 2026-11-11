# dsh-delete-conversation

[English](README.md) | 简体中文

一个 DSH（host runtime）插件，为 Web UI 侧边栏的每个对话增加 **「删除对话」** 操作——
并且真正删除 DSH 本身完全没有提供删除方式的会话本地数据。

## 为什么需要这个插件

DSH 有意地 **不提供** 任何删除对话的能力。相关包都明确写明了「清理属于外部运维」：

| 包 | 官方声明的限制 |
|---|---|
| `dsh-session-persistence` | "No deletion or retention API"（无删除或保留 API） |
| `dsh-session-persistence-jsonl` | "Nothing deletes session files"（没有任何东西会删除会话文件） |
| `dsh-client-ui-workspace` | "No Session deletion — archived but never deleted"（可归档，但永不删除） |
| `dsh-session-projection-cache` | "No eviction or retention surface"（无淘汰或保留接口） |

因此对话会无限累积。本插件在 Host 端把缺失的这项能力实现一次，并通过认证路由提供给 Web UI。

## 删除哪些内容

点击 **「删除对话」** 会先弹出确认框，**列出所有将被删除的内容**。在你确认之前，不会删除任何东西。

### 1. 本地对话缓存 —— 自动删除

| 内容 | 位置 |
|---|---|
| 会话日志 | `$DSH_HOME/sessions/--<项目>--/<id>/session.v4.jsonl.zstd` |
| 历史格式版本 | 同一目录（`session.jsonl`、`session.v1…vN`） |
| 投影缓存 | `$DSH_HOME/storages/session_projcache/sessions/<id>.json` |
| Spill 临时文件 | `<临时目录>/dsh-spill-*/session-<sha256(id)[:12]>/` |
| 工作区归属记录 | `workspace.json` 的 `sessionIds`、`archivedSessionIds`、`pinnedSessionIds` |

### 2. 产出的文件 —— 可选，逐个勾选

`present` 工具会把交付物路径记录为持久化的 `deliverables/presented` 会话事件。
本插件在**日志被删除之前**读取这些事件（日志是这些路径的唯一记录），并以复选框形式提供给你选择。

**除非你主动勾选，否则绝不会删除这些文件。**

## 安全设计

删除是真实且不可逆的，因此插件刻意保持保守：

- **两阶段协议**：`inspect` 只读，返回完整删除计划；`delete` 必须携带精确的确认路径列表。
- **路径白名单**：只接受同一次 `inspect` 返回过的路径，伪造或过期的路径会被拒绝。
- **会话 ID 校验**：必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$`，`../` 与绝对路径穿越无法触达文件系统。
- **内容寻址缓存不动**：`attachments/v1/objects/` 下的附件对象在多个会话与分叉之间共享，永不删除。
- **保护 DSH 自有目录**：`sessions`、`storages`、`attachments`、`cache`、`plugins`、`profiles` 永远不会被当作产出文件。
- **工作区之外的文件保留**：对话工作目录之外的交付路径几乎总是共享资源（技能、工具、库），会标注为「不删除」且不提供勾选。
- **先停止运行中的任务**：通过 DSH 自己的 `archiveSession({ stopActivity: true })` 机制，避免有存活的写句柄继续往已删除的日志里追加。

## 安装

```powershell
# 从 DSH Web UI：设置 → 插件 → 添加本地目录
# 或让 Plugin Manager 指向本仓库：
plugin_manager install_bundle "E:\path\to\dsh-delete-conversation"
```

插件在 `cordis.patch.yml` 中声明补丁：

```yaml
- insert:
    - id: delete-conversation
      name: '@local/dsh-delete-conversation'
```

然后**重启 host runtime**。新安装的 bundle 需要一次全新的 Loader 组合，浏览器端才能注册 UI 槽位。

## 使用方式

1. 打开左侧边栏的任意对话列表。
2. 将鼠标移到某个对话行上，点击 **「...」**。
3. 选择 **「删除对话」**（菜单最后一项）。
4. 查看本地缓存文件清单。
5. 按需勾选要一并删除的产出文件。
6. 点击 **「删除对话」**。

## 国际化

文案提供**中文与英文**两套。两份字典都注册到 Client locale 服务，因此菜单项与对话框会跟随当前语言，无需刷新。

## 文件结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 端：删除逻辑、日志解码、认证路由 `/api/dsh-delete-conversation/rpc` |
| `client.js` | 浏览器端：侧边栏菜单项与确认对话框 |
| `cordis.patch.yml` | 注册插件行的 Loader 补丁 |
| `package.json` | 清单：bundle 补丁 + `dsh.client` 声明 |
| `locale/*.json` | Plugin Manager 的标题与描述 |
| `icon.svg` | Plugin Manager 图标 |

## 设计说明

- **会话日志是唯一事实来源**。产出文件路径只存在于 `deliverables/presented` 事件中，因此在删除日志之前读取。
- **拼接式 zstd 帧**。DSH 每个追加批次写一个独立的 zstd 帧。解码器按帧魔数 `28 b5 2f fd` 切分并逐帧解压。
- **忠实复现 `encodeSegment`**。会话目录名是把注入的 id 编码成单个安全路径片段——多数 id 恰好以 `session-` 开头，但有些是裸 UUID，所以目录名是计算出来的，绝不假设。
- **用普通 Host 路由而非 Typert Remote**。生成的 `ctx.remote.*` 命名空间是构建产物，普通 JS bundle 无法扩展；Host 改为注册认证的 `connection.fetch` 路由，这也是 DSH 自带插件采用的模式。
- **主题原生 UI**。对话框只使用 `--dsw-alias-*` 主题变量，自动匹配明暗主题。

## 验证状态

| 层次 | 状态 |
|---|---|
| Host 删除逻辑 | ✅ 已在真实会话数据上验证（日志、投影缓存、spill 查找均正确命中） |
| 删除流程 | ✅ 已在隔离沙盒 HOME 中端到端验证 |
| 输入加固 | ✅ 非法会话 ID、未确认路径、未知操作均被拒绝 |
| 浏览器渲染 | ⚠️ 需要重启 host 才能加载，本检出中未做视觉验证 |

## 署名要求

**署名是强制性的。** 对本项目的任何使用、复制、修改或再分发——无论全部或部分、源码或二进制形式、包括作为更大作品的一部分——
都必须保留并展示以下署名：

> dsh-delete-conversation by **weapon111**
> https://github.com/weapon111/dsh-delete-conversation

具有约束力的条款见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

## 许可证

MIT，附加强制署名要求 —— 见 [LICENSE](LICENSE)。
