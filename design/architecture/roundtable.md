# 协调对象的引用

```vdm
module Roundtable
exports
  types IssueRef
definitions
types
  -- 一个被协调议题的引用；启动链接与协调器启动参数共用同一种引用，使用方原样传递
  IssueRef = token;
end Roundtable
```
