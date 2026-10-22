# 状态文件原子持久化与裸仓库工作树缓存

实现参考：协调器默认每隔 `120` 秒（`roundtable.recomputeIntervalSeconds`）主动拉取一次 GitHub 事实执行对账；议程状态以 `format: 5` 信封格式保存在 `<roundtable.dataDir>/state/<agendaId>.json`，每次写入先以 `0600` 权限写临时文件并 `fsync`，再 `rename` 覆盖目标文件并对状态目录执行 `fsync`。各仓库在 `<roundtable.dataDir>/repos` 下只克隆一次裸仓库缓存，席位检出使用 `<roundtable.dataDir>/worktrees/<agendaId>` 下的分离头 `git worktree`，返工编写者通过 `SessionManager.forkFrom` 修复中断尾部并复用同一工作树与提示词缓存键。换成其他满足相同原子性与隔离性的轮询周期、存储格式及检出做法，`Ticket`、`Effect` 与 `Seat` 的连接与不变量都不变，所以这些做法属于实现，不写进设计。
