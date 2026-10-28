# 协调

负责 Main 与议程之间的决定：哪些事需要 Main、何时唤醒它、何时结束议程；不负责票据内部的接力，放行与裁定由 Main 直接调用 ``Agenda`Release``、``Agenda`Resolve`` 与 ``Agenda`ResolveClosure``。

## 需求

Main 在回合结束时只被尚未告诉过它、且仍未解决的事唤醒：可放行的票据、待裁定的票据或收口、可结束的议程；它在同一回合里自己解决的事不再唤醒它，在跑的席位与写入不唤醒它（来源：README「Ticket handoff」），由 ``Coordination`Notify`` 走通。

议程只在交付全部完成、有父议题时收口已完成、写入全部结清、没有在跑的席位时由 Main 结束（来源：README「Ticket handoff」），由 ``Coordination`Close`` 走通。
