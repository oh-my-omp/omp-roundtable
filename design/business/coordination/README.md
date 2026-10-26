# 协调

负责 Main 与议程之间的决定：召集与放行、哪些事需要 Main、何时结束议程；不负责票据内部的接力。

## 需求

Main 决定每张票据何时上桌，每张只上桌一次，之后由系统自动接力（来源：README「Ticket handoff」），由 ``Coordination`Open`` 走通。

Main 在回合结束时只被尚未告诉过它、且仍未解决的事唤醒；它在同一回合里自己解决的事不再唤醒它（来源：README「Ticket handoff」），由 ``Coordination`Notify`` 走通。

议程只在交付全部完成、有父议题时收口已完成、没有在跑的席位时由 Main 结束（来源：README「Ticket handoff」），由 ``Coordination`Close`` 走通。
