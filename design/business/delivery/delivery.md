# 票据交付接入

```vdm
module Delivery
imports
  from Ticket
    types
      TicketId renamed TicketId;
      Launched renamed Launched
    operations
      Launch renamed Launch;
      Rework renamed Rework;
      Escalate renamed Escalate;
      Complete renamed Complete,
  from Effect
    types
      Applied renamed Applied
    operations
      Apply renamed Apply,
  from Seat
    types
      SeatSlot renamed SeatSlot;
      Seated renamed Seated
    operations
      Acquire renamed Acquire;
      Release renamed Release
exports
  operations
    RelayTicket: TicketId ==> ()
definitions
operations
  -- 场景：启动票据获取当轮修订号，依次运行编写者席位、执行外部写入、运行门禁席位并完成票据；门禁驳回时进入返工，弃单或写入未确认时升级票据
  RelayTicket: TicketId ==> ()
  RelayTicket(ticket) ==
    cases Launch(ticket):
      mk_Launched(rev) ->
        cases Acquire(mk_SeatSlot(ticket, <Owner>, rev)):
          mk_Seated(ownerSeat, -) ->
            cases Release(ownerSeat):
              <HandedOff> ->
                cases Apply(ticket):
                  mk_Applied(-) ->
                    cases Acquire(mk_SeatSlot(ticket, <Gate>, rev)):
                      mk_Seated(gateSeat, -) ->
                        cases Release(gateSeat):
                          <HandedOff> ->
                            let - = Complete(ticket, rev) in skip,
                          <Rejected> ->
                            let - = Rework(ticket) in skip,
                          <Abandoned> ->
                            let - = Escalate(ticket) in skip
                        end,
                      <Refused> ->
                        let - = Escalate(ticket) in skip
                    end,
                  others ->
                    let - = Escalate(ticket) in skip
                end,
              others ->
                let - = Escalate(ticket) in skip
            end,
          <Refused> ->
            let - = Escalate(ticket) in skip
        end,
      <Blocked> -> skip
    end;
end Delivery
```
