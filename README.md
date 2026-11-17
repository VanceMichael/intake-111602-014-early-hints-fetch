# 网页响应事件查看器

用于检查授权来源的一份原始资料并留存接收凭据。当前提供资料预览、原件接收、凭据列表与摘要回读，资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，展示当前资料并核对保存后的原件；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验已有预览、资料控制和原件持久化；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件。应用只允许配置到本机的资料服务。

`POST /collections` 按来源的 103 Early Hints 采集一个页面的配图，请求体可带 `path` 与 `headers`（请求条件）；`GET /collections`、`GET /collections/<标识>` 回读采集记录。提示触发的领取只是暂定工作：只有最终页面真正采用的资源才写入接收凭据，页面失败、跳转或未采用时暂定领取即作废。同一地址按请求条件区分复用，跳转不越出配置的来源边界；多个页面共享同一份暂定字节时按引用计数保留，取消其中一个页面不会删掉另一个仍在用的字节。采集记录如实列出页面原文、正式资源关系、尚未完成的原因与节省的请求数，不就速度下结论。

## 目录

`source/` 负责资料源的发布日期和传输状态；`src/decode.mjs` 解释一份来源资料；`src/catalog.mjs` 管理不可变原件、接收凭据与采集记录；`src/collect.mjs` 按 103 提示暂定领取并以终页采用为准；`src/app.mjs` 提供查看服务。资料含义及来源控制见 `docs/资料接口.md`。

## 容器

```sh
docker build -t early-hints-fetch .
docker run --rm --network none early-hints-fetch
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
