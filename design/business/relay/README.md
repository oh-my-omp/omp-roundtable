# 接力

负责把已放行的票据一步步推进：复核、按当前步骤派发席位、开始写入、核对完成，以及进程中断后的接管与续接；不负责决定放行与裁定，也不负责席位内部做什么。

## 需求

Main 放行一张票据之后，系统自己接力它的每一步，直到完成或需要 Main（来源：README「Ticket handoff」），由 ``Relay`Advance`` 走通。

进程在席位执行中被结束，操作员确认原进程已结束后恢复，已放行的票据从当前步骤续接，返工的产出席位接续上一个被接受的交接，中断时执行中的写入交给 Main 而不重放（来源：README「Sessions and recovery」与「State-flow simulation」restart），由 ``Relay`Recover`` 走通。
