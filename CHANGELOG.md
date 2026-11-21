# Changelog

## 0.1.0 — 2026-11-21

首个公开版本。

- 每条已完成的助手回复操作条上加一个播放按钮：`▶` 合成并播放、`…` 合成中、`■` 播放中（再点停止）、`⚠` 失败（悬停看原因）。
- 宿主半新增 `GET|POST /dsh-voice-read/tts` 路由，先过 `ctx.connection.requestRejection()` 校验，再调 DeepSeek 官方 TTS，回 `audio/wav`。
- 新增 `voiceId` 配置项：`tide` 男声 / `stella` 女声，默认 `tide`，请求时读取当前配置。
- API key 来源改为配置项 `apiKeyPath`，默认 `~/.dsh/voice/api-key.txt`（`~`/`$HOME` 展开），读不到时退回环境变量 `DEEPSEEK_API_KEY`。
- 不再写死开发者的绝对用户路径，别人装到自己机器上也能直接用。
- 发布物料：`LICENSE`（MIT）、中文 `README.md` + `README.en.md`、`docs/DETAIL.md`（详情页说明）、`icon.svg`、`locale/en.json` + `locale/zh.json`、`CHANGELOG.md`、`.gitignore`。
- `package.json` 补 `description`、`keywords`、`license`、`author`、`repository`、`peerDependencies`（`@deepseek-ai/schemastery`，可选）。
- 保持既有行为：UTF-8 请求体、上游错误码透传（400/401/405/415/502）、2000 字符截断、清洗 Markdown 与 `[表情: ...]`、20 条内存缓存。
