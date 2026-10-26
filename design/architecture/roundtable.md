# 协调对象的引用

```vdm
module Roundtable
exports
  types struct IssueRef
definitions
types
  -- 一个被协调议题的引用；启动链接与协调器启动参数共用同一种写法，启动器与协调器各自从文字解析出它，再按相等比较
  IssueRef = token;
end Roundtable
```
