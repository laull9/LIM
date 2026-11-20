# 备份与恢复

演练使用独立数据库。切换生产库前，停止使用原库的所有 `lim-server` 和嵌入 LIM 的进程，保留原库与备份，准备恢复目标。备份包含会话正文和授权数据，访问权限按源数据库管理。

## 保存和还原快照

SQLite 使用 SQLite 的在线备份功能读取一致快照。以下文件名可替换为实际路径。

```sh
sqlite3 server.db '.backup snapshot.db'
sqlite3 snapshot.db '.backup restored.db'
```

PostgreSQL 使用与数据库兼容的客户端工具和具有备份权限的连接角色。先创建空的恢复目标，再用拥有目标数据库的角色还原。

```sh
pg_dump --format=custom --file=snapshot.dump lim_original
createdb lim_restored
pg_restore --exit-on-error --no-owner --dbname=lim_restored snapshot.dump
```

## 复核权限并切换代次

1. 准备事故前最后使用的服务配置 `old.json`。它提供旧代次和要拒绝复用的令牌摘要。用受保护的方式留存配置和备份。
2. 将 `new.json` 指向恢复目标。SQLite 使用配置文件的 `storage.file`，PostgreSQL 通过 `LIM_SERVER_PG` 指向恢复数据库。设置新的恢复代次 UUID，以及全新的操作员和设备令牌。
3. 按可信的撤销和成员记录复核快照。用新配置的 `devices` 列出快照内仍获准保留全部快照成员关系的设备。每条使用原账号和设备 ID、新的凭据 ID 和令牌摘要。存在未复核会话关系或事后撤销的设备一律省略。空数组会撤销全部旧设备。后续通过新设备 ID 登记和加入会话，按现有加入边界从新游标读取。
4. 在隔离的恢复目标上运行恢复命令。预期输出 `recovered generation=<新 UUID>`。数据库操作在单个事务中执行，保留获准设备的快照成员关系和原始加入边界，撤销其余设备并移除其成员关系，最后切换代次。命令遇到代次不符、已撤销设备、账号不符或旧凭据 ID 会失败。成功后再次运行会报告代次已变。

```sh
lim-server --config new.json --recover-from old.json
lim-server --config new.json
```

客户端重新认证后按新代次获取会话和游标。快照以后的写入可能丢失，同一序号也可能分配给新事件。遇到 `recovery_required` 时重新同步并核对本地待发消息，先确认旧请求在恢复后的状态再决定是否重发。
