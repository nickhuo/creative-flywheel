# 通用优化 Harness · 讨论稿

围绕一个目标，让 Agent 基于实验反馈持续提出更好的方案。**视频是第一个应用。**

> 命名与边界尚未批准，本文不代表已实现协议；现有定义见 [primitives.md](./primitives.md)。

## 1. 整个系统如何运转

```mermaid
flowchart TD
    T["Task · 优化任务<br/>目标 / 参数空间 / 生成规则 / 预算"] --> A
    A["Agent<br/>读结果 → 提假设 → 选参数"] --> V["Variant · 候选方案"]
    V --> G["Generator<br/>Deterministic 或 LLM"]
    T -. 生成规则 .-> G
    G --> F["Artifact · 确定的产物"]
    A -->|提出实验配置| E["Experiment · A/B 实验"]
    F -->|绑定实验组| E
    E --> R["Runner<br/>校验 / 冻结配置 / 执行 / 恢复"]
    R --> ENV{"执行环境"}
    ENV --> SIM["Simulator<br/>历史数据驱动的离线模拟"]
    ENV --> LIVE["Live<br/>真实流量投放"]
    SIM --> S["Snapshot · 结果快照<br/>指标 / 样本量 / 证据来源"]
    LIVE --> S
    S --> P["实验策略<br/>判断胜出 / 继续 / 结束"]
    P -->|结果与决策，未结束则下一轮| A
```

**Agent 提方案；Generator 生产；Runner 执行；实验策略按固定标准判断。** 首轮可以直接使用预先准备的候选。

## 2. 方案与产物为什么分开

```mermaid
flowchart LR
    V["Variant<br/>人物 = Luna<br/>背景 = 咖啡馆<br/>Hook = Your party is waiting."] --> G["Generator<br/>模板渲染 / 视频模型"]
    G --> A["Artifact A<br/>第一次生成的 video.mp4"]
    G --> B["Artifact B<br/>再次生成的 video.mp4"]
    A --> E["Experiment<br/>绑定这一个确定文件"]
```

同一参数可能生成不同内容。**Variant 是输入方案，Artifact 是实际被测试的产物**；投放时不重新生成。保存产物及生成规则、版本等记录。

## 3. 任务、运行与实验的关系

```mermaid
flowchart TD
    T["Task · 长期任务<br/>例如：提高指定受众的安装率"] --> R1["Run · 一次优化执行（建议名）"]
    T --> R2["Run · 另一次优化执行"]
    subgraph TRAJECTORY["一次 Run 的轨迹"]
        E1["Experiment 1<br/>初始 A vs B"] --> E2["Experiment 2<br/>胜者 vs 新候选 C"]
        E2 --> E3["Experiment 3<br/>胜者 vs 新候选 D"]
    end
    R1 --> E1
    E2 --> S1["Snapshot<br/>中途证据，可能尚未就绪"]
    E2 --> S2["Snapshot<br/>完成时的证据"]
```

采用你批注中的短名称 **Task / Experiment / Snapshot**；`OptimizationRun` 暂建议简化为 **Run**，待确认。每次 Run 固定任务配置版本。

## 4. 配置分别归谁

```mermaid
flowchart LR
    subgraph TASK["Task：允许怎么优化"]
        O["目标<br/>主指标 / 方向 / 约束"]
        SPACE["参数空间<br/>可改字段 / 合法值"]
        RULE["生成规则<br/>模板 / 提示词 / 版本"]
        LIMIT["上下文与限制<br/>产品 / 受众 / 预算 / 轮数"]
    end
    TASK -->|限定配置范围| EXP
    subgraph EXP["Experiment：这一次怎么比较"]
        ARMS["分组<br/>对照 / 候选 / 确定产物"]
        TRAFFIC["流量<br/>人群 / 分配单位 / 比例"]
        METRIC["评估<br/>指标口径 / 归因窗口 / 分析方法"]
        STOP["执行<br/>环境 / 样本量 / 期限 / 停止条件"]
    end
```

Agent 在允许范围内配置实验，Runner 校验后冻结。**看到结果后不修改本轮评判标准。**

## 5. Simulator 与 Live 的边界

```mermaid
flowchart LR
    H["历史数据"] --> M["AudienceModel<br/>视频模拟器内部"]
    M --> SIM["Simulator<br/>快速筛选候选"]
    SIM --> SR["模拟证据<br/>保留模型版本与覆盖范围"]
    SR -. "候选进入新的线上验证实验" .-> LIVE["Live<br/>真实展示产物 + 采集行为"]
    PLATFORM["实验平台<br/>例如 Statsig"] --- LIVE
    LIVE --> LR["线上证据<br/>保留人群与实验来源"]
```

- 当前模拟器只看视频参数，不看视频内容，无法区分同参数下的两个生成文件。
- 模拟提升需要线上验证；两类证据分开记录。
- `static` 是否指 Statsig 待确认；Statsig 集成之外仍需接入真实投放端。

## 6. 第一版改到哪里

```mermaid
flowchart TB
    subgraph CORE["通用 Harness"]
        C["Task / Run / Agent<br/>Experiment / Snapshot<br/>执行账本与恢复"]
    end
    CORE --> VIDEO
    CORE --> ENV
    subgraph VIDEO["视频应用"]
        V["六个创意参数 / 产品背景<br/>视频 Generator / 视频产物"]
    end
    subgraph ENV["环境实现"]
        S["Simulator + AudienceModel"]
        L["Live + 投放端 + 实验平台"]
    end
```

第一版保留 **双组 A/B、固定样本量、一个主指标**。保持历史记录可读、执行可恢复；第二个实际应用出现后再扩展抽象。

## 7. 需要一起定的几件事

| 待定项 | 当前建议 |
| --- | --- |
| 系统定位 | Agent 优化 Harness |
| 单次优化执行的名字 | Run，替代草案中的 OptimizationRun |
| 输入与产物 | Variant → Generator → Artifact |
| Agent 能改什么 | 参数与允许范围内的实验配置；本次 Run 的生成规则固定 |
| 一个实验组测试什么 | 一个确定的 Variant + Artifact |
| 环境名称与平台 | Simulator / Live；确认 static 是否为 Statsig |
| 从模拟进入线上 | 新建验证实验；自动切换与无人审核投放策略待定，暂保留现有审核行为 |

确认后再修改实现，并同步更新领域原语清单。
