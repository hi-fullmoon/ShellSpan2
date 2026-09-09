# Rust Core 到 Node Core 迁移计划

## 实施状态

阶段 0 已于 2026-09-09 完成并形成以下受检产物：

- `electron/contracts/v1`：141 个命令参数、141 个命令返回值、17 个固定事件及动态终端事件的版本化 Schema。
- `electron/contracts/v1/manifest.json`：命令领域、迁移波次、资源、依赖、事件和测试责任。
- `docs/migration/command-responsibility-matrix.md`：可审阅的 141 命令责任矩阵。
- `electron/contracts/v1/fixtures.json`：Serde、命令、事件、Agent、LLM 和图片协议黄金 fixture 索引及校验和。
- `docs/migration/security-boundaries.md`：迁移期间必须保持的安全边界。
- `docs/migration/baselines/native-core-darwin-arm64.json`：Rust Core 启动、内存、IPC、PTY、本地复制、SSH/SFTP 和 SQLite v7 基线。

阶段 1 已于 2026-09-09 完成。`CoreBackend`、Rust/Node 适配器、领域路由、独立 Node Core
协议骨架和 `read_text_file` 差分 canary 的证据记录在
`docs/migration/stage-1-completion.md`。在该阶段完成时，所有非 canary 命令仍默认由 Rust 持有。

阶段 2 已于 2026-09-09 完成。`health`、`local-fs`、`logs` 和 `petdex` 四个完整领域的
15 个命令已默认切换到 Node；实现、差分、故障与跨平台证据记录在
`docs/migration/stage-2-completion.md`。在该阶段完成时，数据库和凭据仍由 Rust 独占。

阶段 3 已于 2026-09-09 完成。`storage` 与 `credentials` 两个完整领域的 29 个命令已
默认切换到 Node；SQLite v1–v7、恢复、CAS、旧系统凭据命名和内联 API Key 迁移证据
记录在 `docs/migration/stage-3-completion.md`。

阶段 4 已于 2026-09-09 完成实现与本地验收。`host-trust`、`terminal`、`remote-fs`、
`remote-health` 和 `port-forward` 五个完整领域的 40 个命令已默认切换到 Node；直连、
跳板、主机信任、PTY、SFTP、端口转发、远程健康、取消、异常退出清理、Ubuntu 隔离
E2E 和 macOS 打包证据记录在 `docs/migration/stage-4-completion.md`。Windows ConPTY
实机验收由新增的 `windows-2025` 必过 CI 门禁执行。

阶段 5 已于 2026-09-09 完成实现与本地验收。`llm` 领域的 9 个命令已默认切换到
Node；Provider/模型目录、路由 CAS 与凭据版本化、流式协议、错误/重试/取消、usage、
原始 Provider 回放、Session v4→v5、图片规范化和 Electron 打包证据记录在
`docs/migration/stage-5-completion.md`。

阶段 6 已于 2026-09-09 完成实现与本地 Node 验收。`agent-runtime` 领域的 42 个命令已
默认切换到 Node；Session v5 事件存储与投影、Inbox、模型 Turn、工具审批与执行、用户
问题、文件/SFTP/图片/artifact、压缩归档与恢复、子 Agent 和 Fleet 证据记录在
`docs/migration/stage-6-completion.md`。Rust Core 继续随包保留，供阶段 7 整体回退。

TypeScript 桌面类型、命令清单和事件清单现在从 Schema v1 生成；Electron 主进程使用同一 Schema 执行 Ajv 深层参数校验。常规契约生成与检查不再解析 Rust 源码。

## 1. 目标与范围

本计划用于将 ShellSpan 的 Rust Core 渐进迁移到 Node.js/TypeScript，同时满足以下目标：

- 保持 Renderer、Preload 和 Electron IPC 的公开接口稳定。
- 完整保留 SSH、SFTP、本地终端、端口转发、数据存储、系统凭据、LLM 和 Agent Runtime 能力。
- 兼容现有数据库、工作区、AI 会话、系统凭据和升级恢复流程。
- 继续支持 macOS 与 Windows；Linux 至少保留 SSH/SFTP 自动化验证能力。
- 迁移过程可以逐领域启用、验证和回滚，避免一次性替换全部 Rust 实现。
- 最终开发、测试和打包流程不再依赖 Cargo，也不再分发 `shellspan-core`。

本计划默认允许使用 Node 原生扩展。若目标同时要求“纯 JavaScript、不能包含任何原生二进制”，则本地 PTY、系统凭据和部分高性能图片处理需要重新评估，不能直接套用本计划中的技术路线。

## 2. 当前基线

当前仓库大致包含：

- 约 90,000 行 Rust Core 代码。
- 约 46,000 行 Agent Runtime 代码。
- 约 10,000 行 LLM 代码。
- 141 个桌面命令。
- 约 705 个 Rust 测试入口。

Rust Core 当前负责：

- SSH 会话、跳板机、主机密钥验证和连接预检。
- SFTP 连接池、目录操作、上传、下载、远程复制和取消控制。
- 本地 PTY、终端生命周期和异常退出后的进程树清理。
- 端口转发、远程健康检查和远程命令执行。
- SQLite schema、数据迁移、工作区、配置和会话持久化。
- macOS Keychain、Windows Credential Manager 等系统凭据访问。
- LLM Provider、路由、流式响应、重试、用量和会话转换。
- Agent Session、事件日志、恢复、压缩、权限、工具调用、文件引用、图片和子 Agent。

Electron 已经通过独立子进程和结构化协议访问 Rust Core，因此现有边界可以直接用于渐进迁移，而不需要先修改 Renderer。

## 3. 迁移原则

### 3.1 按领域迁移，不按文件翻译

迁移单元应是拥有完整资源生命周期的命令领域，例如数据库、SSH Session 或 Agent Session，而不是单个 Rust 文件。一个领域完成迁移后，其状态、取消注册表和资源句柄必须全部由同一个后端管理。

### 3.2 保持现有桌面契约

迁移期间以下内容保持兼容：

- 命令名称、参数结构、默认值和未知字段处理。
- 返回值、错误类型和用户可见错误信息。
- 事件名称、payload、事件顺序和终端序号。
- 启动、停止、失败、超时和恢复语义。
- 数据库 schema、文件布局、凭据 service/account 命名。

### 3.3 避免双写

Rust 和 Node 不得同时修改同一个 SQLite 数据库、工作区文件或系统凭据，也不得共同持有同一个 SSH、SFTP、PTY 或端口转发会话。

只读操作可以在隔离副本上双跑比对。写操作只能使用 fixture、临时数据库、录制回放或明确的单后端所有权。

### 3.4 每个阶段可独立回滚

迁移期间保留 Rust Core，并通过领域级功能开关选择后端。每个阶段必须有明确的进入条件、退出条件和回滚路径。

## 4. 目标架构

```text
Renderer
   |
   v
Preload / Electron IPC
   |
   v
CoreBackend
   |-- RustCoreBackend     迁移期基线与回退
   `-- NodeCoreBackend     最终实现
```

Node Core 建议继续运行在独立 Node 或 Electron Utility Process 中，而不是直接合并进 Electron Main。这样可以保留现有故障隔离、启动握手、请求上限、独立终端通道和关闭超时语义。

建议新增以下边界：

```ts
interface CoreBackend {
  readonly ready: Promise<CoreReady>;
  invoke(command: DesktopCommand, args: unknown): Promise<DesktopResult>;
  validate(command: DesktopCommand, args: unknown): Promise<DesktopResult<null>>;
  stop(): Promise<void>;
  onEvent(listener: CoreEventListener): Unsubscribe;
}
```

后端选择必须按领域配置，不能按单个有状态命令随意切换。例如 `create_session`、`write_session`、`resize_session` 和 `close_session` 必须属于同一个后端。

## 5. 分阶段实施计划

### 阶段 0：契约冻结与基线建立

预计：1–2 周。

工作内容：

- 建立 141 个命令的责任矩阵：命令、参数、返回值、事件、资源、依赖模块和测试。
- 将参数和返回值整理为版本化 JSON Schema。
- 使用 JSON Schema 生成 TypeScript 类型，并由 Ajv 执行运行时校验。
- 记录 Rust Core 的黄金响应、错误、事件序列和数据文件 fixture。
- 建立启动耗时、内存、终端延迟、传输吞吐和 Agent 长会话基线。
- 标记所有安全边界：主机密钥、凭据、权限批准、日志脱敏和路径限制。

退出标准：

- 141 个命令均有明确的 Schema 和所属领域。
- 所有 Renderer 可见事件都有 payload Schema。
- 关键错误和 Serde 边界行为都有黄金 fixture。
- 新增契约时不再要求从 Rust 源码解析类型。

### 阶段 1：双后端骨架

预计：1–2 周。

工作内容：

- 抽取 `CoreBackend` 接口。
- 将现有 `NativeHost` 封装为 `RustCoreBackend`。
- 新建 Node Core 入口、dispatcher、状态容器、事件发送器和关闭流程。
- 保持现有控制通道和终端通道协议，或实现完全等价的 MessagePort 通道。
- 增加领域级后端配置，例如 `SHELLSPAN_CORE_BACKENDS=local-fs:node,ssh:rust`。
- 选择一个确定性的只读命令作为 canary，实现 Rust/Node 对照测试。

退出标准：

- Renderer 和 Preload 无需修改即可调用两个后端。
- Node Core 能完成 ready、request、response、event、stop 和异常退出流程。
- canary 命令在两个后端产生一致结果。

### 阶段 2：基础设施与低风险本地能力

预计：2–3 周。

迁移范围：

- App state、事件分发和取消注册表。
- 路径转换和数据目录定位。
- 日志、脱敏和诊断信息。
- 本地健康检查。
- 本地目录读取、复制、移动、重命名、删除到回收站和文本读取。
- Petdex 等不持有 SSH/数据库事务的独立适配器。

注意事项：

- 大目录扫描、复制、哈希和图片处理不得阻塞 Core 事件循环。
- 取消后不得继续产生进度事件或写入目标文件。
- Windows 长路径、盘符、UNC 路径和 macOS Unicode 文件名必须单独验证。

退出标准：

- 该领域命令全部默认切到 Node。
- 文件操作的成功、冲突、取消和部分失败结果与 Rust 基线一致。
- 压力测试中终端事件循环不受大文件操作阻塞。

### 阶段 3：数据库、数据迁移与系统凭据

预计：3–4 周。

迁移范围：

- SQLite schema v1–v7 和 schema version 检查。
- Profiles、Preferences、Recent Profiles、Bookmarks 和 Workspace。
- LLM route 持久化所需的事务与 compare-and-swap 语义。
- 启动数据迁移、迁移备份、离线恢复和中断恢复。
- 系统凭据读写、删除、枚举和旧 service/account 兼容。
- 内联 API Key 到系统凭据的迁移。

技术验证：

- 比较 `node:sqlite` 与 `better-sqlite3` 的事务、备份、WAL、打包和性能表现。
- 验证 macOS Keychain 与 Windows Credential Manager 的旧凭据可见性。
- 明确 Electron `safeStorage` 是否仅用于新存储，不能假设它与现有系统凭据兼容。

数据安全要求：

- 所有升级测试使用真实数据结构的副本。
- 任何迁移失败均不得修改唯一一份原始数据。
- 不支持的新 schema 必须拒绝打开且不能写入数据库。
- 密钥和密码不得出现在 SQLite、日志、错误或诊断包中。

退出标准：

- 从每个历史 schema fixture 升级后数据与 Rust 结果一致。
- 迁移中断后能够恢复或离线回滚。
- 用户升级后不需要重新录入已有凭据。

### 阶段 4：SSH、SFTP、远程执行和本地终端

预计：4–6 周。

迁移范围：

- DNS、TCP、SSH 握手、算法协商和认证。
- known_hosts 读取、哈希主机条目、主机密钥检查与信任。
- 密码、私钥、证书、passphrase、keyboard-interactive 和跳板机。
- SSH Terminal Session、状态机、重连、暂停输出、resize 和关闭。
- SFTP Pool、目录缓存、上传、下载、远程复制、权限和 owner 解析。
- 本地/远程端口转发。
- 远程健康检查和受审计的远程命令执行。
- 本地 PTY 与异常退出后的进程树清理。

候选依赖：

- `ssh2`：SSH、交互 Shell、SFTP、跳板连接和端口转发。
- `node-pty`：macOS、Linux 和 Windows 本地 PTY。

高风险验证：

- `node-pty` 与当前 Electron ABI、ASAR、代码签名及目标 CPU 架构的兼容性。
- Windows ConPTY 必须继续接收 xterm 风格 VT 输入，不能退回 Win32 input mode。
- Unix 必须清理同一 session 下的前台和后台进程。
- Windows 必须验证关闭应用后所有终端子进程都被终止。
- 主机密钥确认之前不得发送任何认证凭据。
- 终端 UTF-8 分片、非法字节、事件序号、ACK、背压和 Renderer 重载行为保持一致。

退出标准：

- macOS、Windows 的终端和连接测试全部通过。
- Ubuntu 隔离 SSH/SFTP E2E 全部通过。
- 直连、跳板、密钥变化、错误凭据、断线、重连和取消行为与基线一致。
- 大文件、大目录和多并发 SFTP 测试无资源泄漏。
- Core 或 Electron 异常退出后不残留本地终端进程。

### 阶段 5：LLM Runtime

预计：2–4 周。

迁移范围：

- Provider 配置、模型目录、路由选择和模型解析。
- 流式请求、错误分类、超时、重试和取消。
- Usage 归一化、Provider 原始内容保存和回放。
- Session v4 到 v5 转换。
- 图片准备、预览、大小限制和提交。

验证方式：

- 使用录制响应进行离线回放，不让测试依赖真实 Provider。
- 对比 Rust/Node 生成的标准化事件序列。
- 单独保留可配置的 Provider live smoke，但不作为普通本地测试前提。

退出标准：

- 所有 Provider fixture 在 Node 中可稳定重放。
- 流式中断、重试和 usage 结果与现有契约一致。
- 会话转换保持幂等并保留原始备份。

### 阶段 6：Agent Runtime

预计：4–6 周。

迁移范围：

- Agent Session 创建、启动、事件存储和投影。
- 模型切换、权限模式、用户问题和 steering。
- Inbox、follow-up、interrupt、cancel 和 resume。
- 工具注册、参数校验、批准、拒绝、执行和结果脱敏。
- 文件引用、SFTP 引用、图片引用和 artifact。
- Compaction、checkpoint、archive 和 crash recovery。
- 子 Agent、fleet plan、并发控制和协调状态。

实施方式：

- 先迁移不可变模型、事件类型和纯投影函数。
- 再迁移单 Session 状态机和持久化。
- 然后接入工具执行、SSH/PTY 和文件适配器。
- 最后迁移子 Agent、fleet 和恢复协调。

退出标准：

- 单轮、多轮、长会话和压缩后的事件投影与 Rust fixture 一致。
- 批准、拒绝、取消、重复请求和崩溃恢复不会重复执行副作用。
- 子 Agent 并发、输入转发、取消和恢复测试全部通过。
- 安全测试确认工具输出始终被视为不可信数据。

### 阶段 7：默认切换、发布与 Rust 清理

预计：1–2 周。

发布步骤：

1. 内部版本默认使用 Node，Rust 作为环境变量回退。
2. Beta 版本同时打包两个 Core，收集启动、崩溃和兼容性结果。
3. 稳定版默认 Node，并保留一个发布周期的 Rust 回退。
4. 确认无阻断问题后删除 Rust Core、Cargo 构建、Rust CI 和打包资源。

清理范围：

- 删除 `native/Cargo.toml`、`native/Cargo.lock` 和 Rust 源码。
- 删除 `native:build`、`native:release` 和 `test:native` 脚本。
- 删除 electron-builder 中的 `shellspan-core` extra resource。
- 将 Rust CI 替换为 Node Core 的 macOS/Windows 测试矩阵。
- 更新版本检查、release metadata、缓存和开发文档。

退出标准：

- 开发、测试、打包和发布链路均不调用 Cargo。
- 安装包中不包含 `shellspan-core`。
- Node-only 安装包可从上一稳定版本原地升级。
- 至少完成一个稳定发布周期的崩溃与升级观察。

## 6. 并行工作流

建议按以下四条工作流组织：

| 工作流            | 负责范围                                     | 主要依赖             |
| ----------------- | -------------------------------------------- | -------------------- |
| A：契约与基础设施 | Schema、类型生成、CoreBackend、Node Core、CI | 最先启动             |
| B：平台能力       | SQLite、数据迁移、凭据、PTY、打包            | 依赖 A 的边界        |
| C：远程能力       | SSH、known_hosts、SFTP、转发、远程健康       | 依赖 A，部分依赖 B   |
| D：AI Runtime     | LLM、Agent、工具、恢复、子 Agent             | 依赖 A，后期依赖 B/C |

三人团队可让 A/B、C、D 并行推进，但阶段 0 的契约和阶段 1 的双后端骨架必须先稳定。

## 7. 测试策略

### 7.1 契约测试

- 每个命令验证成功、参数缺失、类型错误、边界值和未知字段。
- 每个事件验证名称、payload、顺序和取消后的静默行为。
- 对错误进行分类，不只比较字符串。

### 7.2 差分测试

- 对纯函数和只读命令同时运行 Rust/Node 并比较标准化结果。
- 时间、UUID、临时路径等非确定字段先归一化。
- 写操作在独立临时目录或数据库副本中分别运行，然后比较最终状态。

### 7.3 故障注入

- Core 启动超时、协议损坏、异常退出和强制终止。
- 网络断开、SSH 半开、SFTP 中断和端口占用。
- 数据库锁定、磁盘满、只读目录和迁移中断。
- Renderer 重载、ACK 丢失、终端消费者暂停和事件积压。
- LLM 超时、限流、无效流式数据和取消竞态。

### 7.4 跨平台验证

- macOS arm64、macOS x64（若继续发布）。
- Windows x64，以及产品计划要求的 Windows arm64。
- Ubuntu x64 的 SSH/SFTP E2E。
- 每个平台验证开发模式、打包目录和正式安装包。

## 8. 关键风险与应对

| 风险                                       | 等级 | 应对措施                                                          |
| ------------------------------------------ | ---- | ----------------------------------------------------------------- |
| PTY 和终端子进程清理语义不一致             | 极高 | 最先做平台 spike；加入强杀 Core 后的残留进程测试                  |
| SSH 算法、密钥格式和跳板行为差异           | 极高 | 使用隔离 OpenSSH fixture 覆盖算法、密钥和跳板矩阵                 |
| 系统凭据无法读取旧记录                     | 极高 | 在真实 macOS/Windows 环境验证原 service/account，不通过则阻止切换 |
| Agent 并发和恢复产生重复副作用             | 极高 | 事件回放、幂等键、故障注入和重复启动测试                          |
| Node 事件循环被文件、SQLite 或图片任务阻塞 | 高   | 独立 Core 进程、worker pool、背压指标和 watchdog                  |
| 原生 Node 扩展打包失败                     | 高   | CI 构建每个目标架构，检查 ABI、ASAR、签名和安装包加载             |
| Rust/Node 双后端同时写数据                 | 高   | 领域级独占所有权，禁止按单命令切换有状态资源                      |
| 错误信息变化导致 UI 判断失效               | 中   | 将 UI 依赖的错误升级为稳定错误码，并保留兼容文案                  |

## 9. 最终验收标准

- 141/141 个命令和全部 Renderer 事件完成 Schema 与自动化测试覆盖。
- 现有数据库、工作区、AI 会话和系统凭据无损兼容。
- 主机密钥验证发生在任何凭据发送之前。
- 密钥、密码和 API Key 不进入数据库、日志、错误或诊断包。
- SSH/SFTP、跳板机、端口转发、断线重连和取消测试通过。
- 终端事件序号、ACK、背压、UTF-8 分片和进程清理行为通过回归测试。
- Agent 中断、恢复、批准、重试和子 Agent 流程不会重复执行副作用。
- 性能不超过阶段 0 确定的启动、内存、终端延迟和传输吞吐预算。
- macOS 与 Windows 安装包通过冷启动、上一版本升级和异常恢复验证。
- `package.json`、CI 和 electron-builder 中不再存在 Rust 构建或 Core 打包步骤。

## 10. 第一阶段交付清单

建议首先创建以下任务：

1. 生成 141 个命令的领域与依赖责任矩阵。
2. 将命令、返回值和事件定义迁移到版本化 JSON Schema。
3. 新建 `CoreBackend`、`RustCoreBackend` 和 Node Core 空壳。
4. 选择一个确定性只读命令完成双后端差分测试。
5. 完成 `node-pty` 的 macOS/Windows 打包和进程清理 spike。
6. 完成 SQLite v1–v7 fixture 的 Node 打开、迁移和回滚 spike。
7. 完成旧系统凭据读取兼容性 spike。
8. 为后续阶段建立 Node Core 的单元测试、集成测试和跨平台 CI 模板。

完成以上清单后，再根据三个技术 spike 的结果锁定 PTY、SQLite 和 Credential Store 的最终实现。

## 11. 参考资料

- Node.js SQLite API：<https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>
- ssh2：<https://github.com/mscdex/ssh2>
- node-pty：<https://github.com/microsoft/node-pty>
