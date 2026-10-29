# Agent 签名更新实现

监控进程保持 `User=moni`、`NoNewPrivileges`、只读系统目录。升级只把明确的稳定版本写入 `/var/lib/moni/update-request`，不执行 shell，也不接受命令提供的下载地址。root 拥有的独立 systemd helper 读取这个不可信请求，下载固定仓库的发布产物，先验证签名、再验证对应架构的 SHA-256，之后原子替换程序。默认无人查看的实时上报周期为 30 秒；1 秒采样与分钟汇总独立。

## 发布设置

使用 RSA 3072 位或以上密钥。私钥放在 GitHub Actions Secret `AGENT_RELEASE_SIGNING_KEY`，公钥提交为 `scripts/release-public.pem`，同时内置于 `scripts/install-agent.sh`。首次安装信任管理员从可信渠道取得的安装脚本，由脚本自动固定公钥到主机；后续安装和更新复用本机固定公钥，不从待验证的 Release 下载新的信任根。发布验签公钥与每台服务器的连接 token 独立，新增节点或轮换 token 无需处理公钥。

以下命令仅为维护者配置示例，私钥不得提交到仓库：

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out release-private.pem
openssl pkey -in release-private.pem -pubout -out release-public.pem
gh secret set AGENT_RELEASE_SIGNING_KEY < release-private.pem
```

每次发布先更新 `workspace.package.version`，再创建完全对应的 `vX.Y.Z` tag。发布工作流使用独立 `agent-release` profile（`opt-level=z`、`panic=abort`、LTO、单 codegen unit，仍只 strip 原生 Agent）。Worker 的 release 配置及 wasm-bindgen 所需段不受影响。工作流生成包含两个架构程序、安装/更新脚本及公钥的 `SHA256SUMS`，比较私钥导出的公钥、仓库公钥和安装器内置公钥，再生成 `SHA256SUMS.sig`；缺少密钥或三者不匹配则不发布。

## 启用

在管理页面新增节点后，直接复制包含地址、仓库和 token 的安装命令。使用从可信仓库取得的安装器即可，无需单独下载公钥：

```sh
curl -fsSL https://github.com/xingcanlee/moni-rs/releases/latest/download/install-agent.sh \
  | sudo sh -s -- --repo xingcanlee/moni-rs \
      --server wss://monitor.example/ws/agent --token mn_SERVER_SECRET
```

`v0.1.2` 的安装器可直接接入使用协议 3 的 Agent；旧协议主机需要管理员手动执行一次安装命令。安装期间主机会短暂离线。

已配置签名更新的主机可不带参数重跑安装器，自动读取本机固定仓库、公钥并保留连接与采集配置：

```sh
curl -fsSL https://github.com/xingcanlee/moni-rs/releases/latest/download/install-agent.sh | sudo sh
```

仅保留旧版 `agent.env`、尚未固定仓库和公钥的主机，首次迁移时在上述命令末尾使用 `sudo sh -s -- --repo xingcanlee/moni-rs`，即可保留现有地址、token 和采集配置；之后无需再传仓库。

轮换 token 后，复制页面生成的新命令再执行即可。显式 `--token`、`--server`、`--interval` 只替换对应配置项；未传入的字段、网卡、磁盘及其他自定义项保持原值。也可在已有安装脚本上运行 `sudo sh install-agent.sh --token mn_NEW_SECRET`，只更换连接凭据并重启。无需额外的 `--reconfigure` 开关。

安装和升级都必须通过签名校验；缺少 `SHA256SUMS.sig` 或验签失败时不会修改现有安装。默认可由管理 API 下发升级；安装时加 `--auto-update`，systemd timer 会每 6 小时检查一次最新稳定版，并加随机延迟。也可立即执行 `sudo systemctl start moni-agent-update-auto.service` 检查并安装更新，无需再次提供地址、token 或公钥。

更换发布信任根属于管理员操作：先核实新公钥，再用 `--update-public-key /trusted/path/release-public.pem` 显式配置。安装器不会用内置公钥静默覆盖已有固定公钥。fork 发布时需要同步修改仓库公钥和安装器内置公钥。

安装器把仓库与公钥固定在 root 拥有的 `/etc/moni/update.conf` 和 `/etc/moni/release.pub`，把 helper 放在 `/usr/local/libexec/moni-agent-update.sh`。监控进程只得到 `MONI_UPDATE_REPO`，通过 `wss://` 连接时声明升级能力。请求目录属于 moni，mode 0700；root 私有状态、并发锁及上一版本保存在 `/var/lib/moni-update`。升级请求按完整文件原子发布，helper 先原子移入 root 私有目录再检查，避免跟随请求符号链接。

helper 限制 HTTPS、连接/下载超时和产物大小，先把 latest 解析到明确 tag，禁止降级；验签失败或版本不符不替换现有程序。替换前保留旧程序，新进程必须在 45 秒内完成 Hub Welcome 握手，并写入匹配目标版本与 systemd MainPID 的健康标记，再持续保持 active，否则恢复旧程序并重启。健康标记不是远程证明，Hub 另外等待新连接报告目标版本；下载、验签或回退失败会最终显示为任务超时，详细原因由主机 systemd 日志排查。断电或 SIGKILL 发生在替换过程中时，root 私有 pending 标记会使下次 helper 运行先恢复上一版本；未启用自动 timer 时需要手动启动更新服务完成该恢复。

## 管理 API

部署变量 `AGENT_RELEASE_REPO` 必须与主机固定仓库一致。管理页可调用 `POST /api/agent-updates` 指定版本及服务器 ID，再轮询 `GET /api/agent-updates`；类型与终态见 [api.md §7](api.md#7-管理端统一升级)。本次不修改前端页面。离线任务及状态保存在 SQLite，DO 重建不会丢失。

## 安全审查范围

更新不能绕过本机公钥信任：管理端被盗也不能让 helper 安装未签名的任意程序；签名私钥或可信发布代码被控制仍可能导致整批主机执行恶意程序，需保护仓库和 Actions Secret。监控用户不能修改 helper、固定仓库或公钥。管理端的成功状态依据 Agent 自报版本，不是密码学远程证明；Agent token 泄露后，攻击者仍能伪报版本和指标。

同时修复了管理员改密码后旧 Cookie 仍有效、重复 Hello 反复写库、完全相同 Rollup 重试仍写库的问题。公开看板仍会消耗共享免费额度，公开 WebSocket 握手不能依靠历史缓存消除成本；本次没有添加 Cloudflare 入口限流规则。Agent token 泄露也仍可能被用于制造连接或不同的有效数据，应及时轮换；这些剩余风险不能用签名更新替代处理。
