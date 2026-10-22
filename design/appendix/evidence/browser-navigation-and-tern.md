# 浏览器跨协议导航头与 Tern 守护进程行为

证据：任何网页均可通过子资源向 `127.0.0.1` 发起 GET 请求，且 GitHub 的 `no-referrer-when-downgrade` 策略在 `https` 跳转到本地 `http` 链接时剥离 `Referer` 头，只有 `Sec-Fetch-Mode: navigate` 与 `Sec-Fetch-User: ?1` 标识操作员的主动点击导航；同时 Tern 守护进程在无窗口客户端连接时仍保留后台会话，且已退出的命令块仍保留 `live: true` 并附带 `exited` 退出码。这份材料只作为根模块依据的证据，不设立规则。
