# ADR-001 · 书库数据层改为「可配置路径 + Markdown 真相层」

- 状态：已实施（2026-11-12）
- 决策人：用户 / Tank543jq123
- 范围：dsh-manuscript 的库根解析、条目存储、索引重建、迁移、配置入口
- 取代：2026-11-12 早些时候的「HTTP provider + 独立服务」草案（用户明确否决：不需要登录/端口/进程）

---

## 1. 背景与问题

现状的库根固定在 `~/.dsh/dsh-manuscript`（`DSH_MANUSCRIPT_ROOT` 只能测试用），
库内容是 `library.json + entries/*.json + volumes/` 的私有 JSON 结构：

- 本机 `web` 与 `superagent` 两个 DSH 实例各自看到的是同一路径，但**换一台机器/换一个 profile 就要重新找路径**；
- 条目是 JSON 大对象，人想直接读、想用 git diff 看「这次多记了什么」都很别扭；
- 路径写死在代码里，面板无法改，发布给别人时只能让人改环境变量或改源码。

先前的「HTTP provider + 独立服务」方案能解决共享，但引入了端口、token、进程守护、
网络失败降级等一整套复杂度，用户判断**代价大于收益**，明确否决。

## 2. 决策

**一句话：库根变成可配置的本地目录；目录里的真相是「一条目一 Markdown」；
JSON 索引由扫描 Markdown 重建；多个实例指向同一路径即可共享。**

不引入 HTTP、不引入端口、不引入登录、不引入后台服务进程。

### 2.1 库根解析顺序

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1（最高） | 环境变量 `DSH_MANUSCRIPT_ROOT` | 测试/CI/运维的硬覆盖；一旦设置，面板配置不生效（避免测试被本机配置污染） |
| 2 | 面板配置 `~/.dsh/dsh-manuscript-config.json` 的 `root` | 正常使用时的切换入口；路径必须是绝对路径 |
| 3（兜底） | `~/.dsh/dsh-manuscript` | 与改动前完全一致 |

配置文件路径可用 `DSH_MANUSCRIPT_CONFIG` 覆盖（测试隔离用）。
配置损坏 / 字段非法 / 路径不存在时：**记一条 warning，回退到下一优先级，绝不抛错、绝不崩**。

> 为什么不把配置放进库根：库根本身是配置的结果，放进去会形成「要先知道新路径才能读到指向新路径的配置」的循环。

### 2.2 面板入口

新增 `GET/POST /dsh-manuscript/api/library-config`：

- `GET`：返回当前生效根、来源（env / config / default）、配置是否被环境变量覆盖、存储格式（markdown / json）、条目数/册数、警告。
- `POST { root }`：写配置文件（原子写），随后立即重扫并返回新库的条目数/册数。
  - 只接受**绝对路径**且目录已存在；
  - 只接受 Markdown 库或空目录；旧 JSON 库会被拒绝并提示先跑迁移脚本（避免切换后旧建库流程覆盖共享内容）；
  - 写操作沿用既有 `x-dsh-manuscript: 1` 守门头与 Host 回环校验；
  - 不重启宿主：`defaultLibraryRoot()` 每次解析都会读取配置（带 mtime 缓存），下一次扫描即生效。

前端在「维护」区新增「库路径 · 多实例共享」折叠，输入框 + 保存，显示当前来源与警告。

### 2.3 目录结构（Markdown 真相层）

```text
<library-root>/
├── library.json                    # 派生索引，storage: "markdown"；可删，扫描 MD 重建
├── vol-01/                         # <册>
│   ├── MANUAL.md                   # 可选，人读的册导览（不参与条目扫描）
│   ├── TOC.md                      # 可选
│   └── ch-硬件与器件/               # <章>
│       └── e-1a2b3c4d5e6f.md       # 一条目一文件
├── vol-03/
│   └── ch-提示词与技能/
│       └── e-7f3a91a2b3c4.md
├── vol-05/
│   └── ch-inbox/
├── legacy-json/                    # 迁移后旧 JSON 原样保留（不再参与读写）
│   ├── entries/
│   ├── volumes/
│   └── library.json
├── runs/  snapshots/  archive/     # 运行时/历史产物，语义不变
└── vectors.json  distill-state.json  check-settings.json  # 可选运行时状态
```

规则：

- 册目录固定为 `vol-XX`；章目录为条目 `chapter` 字段的安全化 slug；文件名 `<id>.md`。
- 扫描只认**带 front-matter `id`** 的 `.md`；`MANUAL.md` / `TOC.md` / `README.md` 跳过。
- 路径段做安全化（去掉 `/ \ : * ? " < > |`、控制字符与 `..`），避免目录穿越。
- `library.json` **不是真相**，是派生索引；手改会被下一次重建覆盖。

### 2.4 条目 Markdown 格式

```markdown
---
id: "e-7f3a91a2b3c4"
title: "I2C 从机 ISR 里不要调阻塞日志"
volume: "vol-02"
chapter: "ch-通信协议"
confidence: "high"
authority: "L2"
claim: "在 I2C 从机中断里调用阻塞日志会拉长 ISR，导致主机侧超时。"
why: "实测把日志改成环形缓冲后，超时消失。"
provenance: {"session_id":"session-...","turn":12,"timestamp":"2026-11-12T10:00:00+08:00"}
meta: {"status":"current","qualityScore":9,"hits":3,"tags":["i2c","isr"],"evidence":{"tools":["bash"]}}
---

# I2C 从机 ISR 里不要调阻塞日志

在 I2C 从机中断里调用阻塞日志会拉长 ISR，导致主机侧超时。

> Why: 实测把日志改成环形缓冲后，超时消失。
```

- 必需字段：`id`、`title`、`volume`、`chapter`、`confidence`、`authority`、`provenance`。
- `claim` / `why` 也放 front-matter，保证 **JSON → MD → 内存对象** 无损往返；正文是给人读的渲染副本。
- 其余字段（`status`、`qualityScore`、`hits`、`tags`、`evidence`、`sessionAt`、`volumeFallback` 等）统一放 `meta` JSON 对象。
- 标量值用 JSON 字符串（也是合法 YAML），`provenance` / `meta` 用 JSON flow mapping。零 YAML 依赖。

### 2.5 索引重建

`lib/markdown-library.js`：

- `scanMarkdownLibrary(root)`：递归扫 `vol-*/*/*.md`，解析 front-matter，返回 `{entries, library, errors}`。`library` 由条目重建（册/章计数、`byVolume`、`counts`，并保留旧索引里的会话统计字段）。
- `rebuildMarkdownIndex(root)`：扫描 + 原子写 `library.json`，写入 `storage: "markdown"` 与 `mdIndexedAt`。有解析错误时**拒绝覆盖索引**（fail-closed），返回错误明细。
- 插件每次扫描（TTL 10 分钟）在内存里用扫描结果，不每个请求写盘；`/api/rescan`、迁移、入册后调用重建。
- MD 模式判定：`library.json.storage === "markdown"`；若索引缺失，检测到 `vol-*/**/*.md` 也按 MD 模式处理（索引可重建，不应因缺索引拒读）。

### 2.6 读写路径

| 场景 | 改动 |
|---|---|
| 快照刷新 `refresh()` | MD 模式：扫会话（为了 UI/提炼队列）但**不 `buildLibrary`**；目录/条目来自 MD 扫描，`snapshot.storage = "markdown"`。绝不用本机会话库覆盖共享 MD |
| `manual_recall` / `manual_read` / `manual_toc` | 不变，仍读 `snapshot.summary`（其数据源变为 MD） |
| `manual_trace` | 改为 `getLibraryEntry(root, id)`：MD 模式读 `.md`，JSON 模式读旧 `.json` |
| `/api/entry` | 同上，优先读 MD 正文（`why`） |
| 查重基线 `readEntriesForDedup` | 改为 `readAllLibraryEntries(root)`，MD/JSON 自动分支 |
| `restoreDistilledSids` | 同上，从条目反推，不依赖固定 `entries/` |
| 入册 `commitEntries` | MD 模式走 `commitEntriesMarkdown`：内容指纹判重、写 `.md`、重建索引；返回结构不变 |
| 启动体检 / 自愈 | `checkLibraryHealth` 检测 MD 模式后走 `markdownHealth`；MD 模式不做 JSON 重建/自愈，只报事实 |
| `buildLibrary` | 仍保留，仅在 JSON 模式运行；MD 模式下不调用 |

### 2.7 迁移

脚本：`scripts/migrate-json-to-md.mjs`

```bash
node scripts/migrate-json-to-md.mjs              # 迁移当前生效根（原地）
node scripts/migrate-json-to-md.mjs --to PATH    # 迁移到共享路径（先复制）
node scripts/migrate-json-to-md.mjs --dry-run    # 只统计，不写盘
```

步骤（fail-closed）：

1. 解析源根；若是空/不是库 → 退出 2。
2. **整目录备份**到 `<from>.backup-<timestamp>`（排除 `models/`、`.build.lock`、`.staging-*`，避免备份 26MB 模型）。
3. 若 `--to` 且目标非空 → 拒绝（除非 `--force`）；先复制源到目标。
4. 逐条把 `entries/*.json` 写成 `<volume>/<chapter>/<id>.md`。
5. 校验：**条目 id 集合相等**、条目数相等、有内容的册集合相等（比单纯计数更强）。
6. 校验通过后：旧 `entries/`、`volumes/`、`library.json` 移入 `legacy-json/`；
   写新的派生 `library.json`（`storage: "markdown"`）；把旧册的 MANUAL/TOC 复制到新册目录（可选、仅供人读）。
7. 打印/返回报告：源/目标条目数、册数、备份路径、耗时；`--json` 输出机读结果。
8. 任一步失败：不移动旧数据、不写新索引，保留 MD 文件供排查，退出 1。

### 2.8 向后兼容

- 默认仍是 `~/.dsh/dsh-manuscript`；未迁移的库继续走原 JSON 建库/读取路径，现有测试不动。
- 迁移是显式动作；迁移后旧 JSON 在 `legacy-json/` 保留，人工可回滚（把 `library.json` 与 `entries/` 搬回即可）。
- 所有新函数对缺目录/坏文件/坏 front-matter 都返回「错误明细 + 降级结果」，不抛到宿主装配层。

## 3. 安全与并发

- 面板配置写操作：Host 必须回环 + `x-dsh-manuscript: 1` 守门头（沿用既有护栏）。
- 配置根必须是绝对路径且已存在，拒绝 `..`、NUL、相对路径。
- 单条目写入用 `writeFileAtomic`（同目录临时文件 + rename）；MD 模式批量入册/索引重建复用 `.build.lock`。
- 多实例共享同一本地路径时：读无锁、写靠 `.build.lock`；跨主机共享（NFS/SMB）不承诺并发写安全，只承诺「单写多读」。这是本 ADR 的明确边界。

## 4. 验证

新增 `scripts/test-library-md.mjs`，并加入 `scripts/test-all.mjs`：

1. 写入 MD → 扫描回来字段/正文一致（round-trip）。
2. 索引重建：删掉 `library.json` 后扫描仍得到同样条目/册计数。
3. 配置切换：临时配置指向库 A，读 A；把 A 复制到 B、配置改指 B，读到**同一批 id/title**。
4. 环境变量覆盖：设置 `DSH_MANUSCRIPT_ROOT` 时压过配置文件。
5. 非法配置：坏 JSON / 相对路径 / 不存在路径 → 回退默认并产生 warning，不抛错。
6. 迁移：临时 JSON 库 → MD，条目数/册数/id 集合一致，源库有备份。
7. 全量 `node scripts/test-all.mjs` 全绿。

## 5. 风险与已知边界

- **MD 是一等真相后，JSON 建库 pipeline 不能再对同一根运行**：MD 模式已显式短路 `buildLibrary`；脚本（如 `redistill-skeletons`）若直接调 `buildLibrary` 仍可能写 JSON，需要后续审计。
- **跨主机共享只保证单写多读**：文件锁的 host 检查对异地进程保守判活，可能拒绝并发写；不承诺 NFS 上的原子性。
- **front-matter 不是完整 YAML**：只支持本项目写出的 JSON 标量/对象；手写复杂 YAML（多行、锚点）会解析失败并报错，不静默吞。
- **正文与 front-matter 可能漂移**：正文只是渲染副本，以 front-matter 为准；扫描不读正文。
- **迁移是单向的**：默认不提供 MD→JSON 回滚脚本；回滚靠备份目录。
- **面板路径切换后，当前进程的向量库句柄会重建**；若新根没有 `models/`，向量召回自动降级为关键词（与现有行为一致）。
- **未重启 DSH 验证不到运行中宿主的热加载**：本 ADR 的代码改动要宿主重启后才生效；本次按用户要求不重启，只做进程内/脚本级验证。

## 6. 回滚

1. 停用新配置：删除 `~/.dsh/dsh-manuscript-config.json`（或改回旧根），设置 `DSH_MANUSCRIPT_ROOT` 到备份目录。
2. 库回滚：把 `<from>.backup-<timestamp>/entries`、`volumes`、`library.json` 搬回库根。
3. 代码回滚：本次改动可整体 revert；MD 文件与备份目录不在 git 跟踪范围内。
