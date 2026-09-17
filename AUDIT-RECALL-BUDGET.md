# Worker recall 开销审计与修复

测量时间：2026-09-13T04:25:41.879Z。按 worker 视角完成代码审计、只读历史计量、同状态回放、修复和本机安装；没有引入新的记忆/审查机制。

## 审计结论

- 自动 recall 每次带入最多 8 个 peer 的完整观察、note_history 和重复说明，worker 自身记忆的预算被挤占。现在保留 peer 身份、活动时间、有效 note_refs 和结构化 intent；完整观察和 supersession 历史仍由 trace_status / trace_find 返回。自己的 notes/unresolved、历史记录和关系索引没有更改。
- 原先裁剪 peers 后仍沿用 8 的翻页偏移，可能跳过未展示的 peer。现在偏移跟随实际展示数量。
- 原先在字节裁剪后才追加 coverage 等元数据，可能使完整摘要再次超限并退回极简 fallback。现在渲染预算包含这些字段；只剩引用的 unresolved 不再标记完整。
- 缩短 recall、compaction 与工具指导文字；保留来源不等于真实性、时效复查、supersedes 只关闭已验证解决项、失败不能报告成功、回执不等于同意等语义。工具名称、参数、权限和执行实现未改变；review 插件未修改。

## 计量纠正

此次读取 26,852 个事件：4,568 个 prepared checkpoints，3,499 个 context.applied，另有 1,069 个 checkpoint 没有对应 applied。

记录到 hook-applied 的 recall 为 34,173,576 B（32.59 MiB），覆盖 244 个会话。prepared 共 45,085,112 B，必须单列，不能与 applied 相加当作注入量。Hook-applied 也不证明请求已被模型消费或产生账单。

现有 46 条 note，来自 22 个会话；含 supersedes 的 note 为 1 条。这支持“写入利用率低”的观察，但没有任务质量对照实验，不能仅凭字节数证明收益低于成本。tools.js 源文件大小也不是模型工具 schema 大小；本次只计算 name/description/input 的 JSON，排除宿主封装、review 和 tokenizer 差异。

## 同状态比较

两个 renderer 使用同一批历史事件重建的最终状态。表格仅包含曾有 checkpoint 的 255 个会话；全部 288 个观察会话均检查了 12 KiB 上限和原本可见的自身 note 引用保留情况。不是把不同时间的旧 snapshot 与新 replay 直接相减，也不是历史请求的反事实 token/费用统计。

| 指标 | 修复前 | 修复后 | 减少 |
| --- | ---: | ---: | ---: |
| Recall 平均值 | 10,890 B | 5,843 B | 46.3% |
| Peer 平均值 | 5,855 B | 1,299 B | 77.8% |
| 静态指导文本 | 1,648 B | 978 B | 40.7% |
| 10 个工具的描述与输入 schema | 9,084 B | 7,162 B | 21.2% |

Recall 中位数 11,403 → 5,852 B。全体回放中 4 个会话变长：3 个保留了更多 peer 信息，1 个恢复展示了更多自身 note；这是平均预算改善，不保证每个快照都单调变小。所有原本可见的自身 note 引用均保留。

## 验证和安装状态

- 修改前全量测试：93/93；修改后：96/96。新增回归覆盖 peer 缩减后的自身记忆/历史恢复、裁剪分页和 unresolved 完整性。
- 安装包 mock-host hook 冒烟通过：10 个工具注册、自身 unresolved 恢复、prepared/applied 引用配对。没有执行真实模型质量对照测试。
- 安装包：`/home/frank/.local/share/opencode-trace/versions/0.1.4-50acac4f53c6d615`。所有打包文件与当前源码逐字节一致。
- `/home/frank/.config/opencode/opencode.jsonc` 仅改动现有 trace 插件的 package 字符串；原配置备份和安装 receipt 已保存。已存在的源码未提交修改保留。
- 旧 OpenCode 进程未重启，不宣称其已经热加载修复。新启动的进程使用配置指向的新包。

原始证据：`/home/frank/audit/trace-recall-trim-20260913T041924Z`。最终计量和事件清单位于 `final/`，全量测试日志 `final-tests.log`，安装 smoke 结果 `installed-smoke/result.json`，部署凭据 `deployment.json`。私有逐会话信息仅保留在本机审计目录。
