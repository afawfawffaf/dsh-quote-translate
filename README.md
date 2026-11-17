# 划词翻译（dsh-quote-translate）

在 DSH Web GUI 里选中聊天正文的任意一段文字，旁边会出现「翻译」按钮，点击后以悬浮卡片显示简体中文译文。

**不消耗任何 LLM token**：翻译请求由浏览器直接发往 Microsoft Edge 的匿名翻译端点，不经过模型、不进上下文、不占 KV cache。

---

## 使用

1. 在聊天正文里选中一段文字
2. 点击选区旁的「翻译」
3. 译文卡片弹出，可**复制**、**拖动**（按住标题栏）、**Esc 关闭**

按钮会自动避让官方的「引用文本」：检测到它就排在它右侧，右侧空间不足时翻到左边。

---

## 架构

```
浏览器                              网络
┌─────────────────────────┐
│ client.js               │        ┌──────────────────────┐
│  ├ selectionchange 监听 │  POST  │ edge.microsoft.com   │
│  ├ 悬浮按钮             │ ─────► │ /translate/          │
│  └ 译文面板             │ ◄───── │ translatetext        │
└─────────────────────────┘        └──────────────────────┘
```

**只有前端，没有 Host 半部分。** 原因见下节。

### 文件

| 文件 | 作用 |
|---|---|
| `client.js` | 全部实现：选区监听、按钮、面板、翻译请求、i18n |
| `index.js` | Host 入口，空实现（`export function apply() {}`） |
| `cordis.patch.yml` | 插入一行 plugin row |
| `package.json` | bundle 清单 + client 入口声明 |
| `locale/{zh,en}.json` | Plugin Manager 里显示的标题与描述 |
| `icon.svg` | 插件图标 |

---

## 关键设计决策

### 1. 为什么没有 Host 半部分

最初的方案是标准的两段式：Host 侧写一个 `TypertRemoteService`，内部调用官方的 `ctx.translator`；Client 侧通过 `ctx.remote` 调用它。

**这个方案在当前部署形态下不可行。** DSH 桌面版的官方包（`@deepseek-ai/dsh-typert-protocol`、`dsh-experimental-translator` 等）全部打包在 `app.asar` 内部：

```
resources/app.asar          ← 官方包在这里，Node 无法从外部 import
resources/app.asar.unpacked/
```

已安装的 workspace bundle 通过 symlink 链接，Node 从 workspace 解析依赖，而 workspace 的 `node_modules` 里没有这些包：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-typert-protocol'
```

所以改为**浏览器直连**。CORS 已实测放开：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST
```

实测请求：

```bash
curl -X POST "https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false" \
  -H "Content-Type: application/json" \
  -d '["Hello world, this is a test."]'
# → [{"translations":[{"text":"世界好，这是个测试。",...}]}]
```

**代价**：逻辑与官方 `dsh-experimental-translator` 重复；如果哪天 asar 依赖变得可解析，可以切回 Remote 方案。

### 2. 为什么用 `shell.overlay` 而不是 text-interaction slot

这是本次开发踩的最大坑。

**官方「引用文本」占用的 slot 是 `conversation.chat.text-interaction`，类型为 `keyed`**。出处：`app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js` 第 15471 行。

```js
"conversation.chat.text-interaction": {
  kind: "keyed",
  scope: "session"
}
```

而 keyed slot 的渲染逻辑是（`dsh-client-ui-renderer/lib/client.js:1179`）：

```js
if (spec.kind === "keyed") {
  const entry = host.entriesOfSlot(slotKey)
    .find((e) => e.options.key === opts?.entryKey)
```

**`find` 只返回第一个匹配项。** `entryKey` 由 host 传入，值是获胜 interaction 的 id（固定为 `'quote'`）。

由此推出：

| 注册的 key | 结果 |
|---|---|
| `key: 'translate'` | `find` 返回 undefined → **不渲染** |
| `key: 'quote'` | `find` 命中官方先注册的那个 → **仍然不渲染自己** |

**结论：这个 slot 从设计上只能容纳一个 action，无法并列第二个按钮。**

改用 `shell.overlay`。出处：`app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js` 第 725 行。

```js
"shell.overlay": {
  kind: "list",
  scope: "root"
}
```

`list` 类型走 `entriesOfSlot(...).map(...)`，**渲染所有注册项**，按 `order` 排序。所以浮层可以独立存在。

代价：不能复用框架的选区定位，需要自己监听 `selectionchange`、自己算位置、自己避让「引用文本」。

### 3. 三种 slot 类型的语义（速查）

理解这个才能选对扩展点：

| kind | 渲染行为 | 能否多插件共存 |
|---|---|---|
| `single` | `entriesOfSlot(slotKey)[0]` | ❌ 只第一个 |
| `keyed` | `find(e => e.key === entryKey)` | ❌ 只一个 key |
| `list` | `entriesOfSlot(...).map(...)` + 按 `order` 排序 | ✅ 全部渲染 |
| `chain` | 遍历 `select()`，第一个非 null 选中 | ⚠️ 择一 |

---

## 实现细节

### 选区过滤

只对**聊天正文**的选区生效：

```js
const SOURCE_SELECTOR = '[data-text-interaction-source]'
```

并且排除输入框内的选区（`contenteditable` / `input` / `textarea`），避免在写消息时误触发。

### 避让「引用文本」

```js
function quoteButtonRect() {
  const surface = document.querySelector('[data-text-interaction-surface]')
  if (surface?.getAttribute('aria-hidden') === 'true') return null
  // 取第一个子元素（实际按钮）的 rect
}
```

检测到就排在它右侧（`quote.right + 6`）；右侧放不下翻到左侧。检测不到就跟随选区。

因为「引用文本」是异步挂载的，用 400ms 轮询重新定位，保证最终不重叠。

### 长文本分片

单次请求上限 1800 字符，超长按优先级切分：

1. 段落分隔 `\n\n`
2. 换行 `\n`
3. 空格
4. 硬切

切分点若落在 UTF-16 代理对中间会回退一位，避免把 emoji 切坏。

### 点击后选区消失

点击按钮会让浏览器清除选区，而 `selectionchange` 会触发 state 更新导致组件卸载。用 `pinned` ref 锁住已捕获的选区，直到面板关闭才释放：

```js
pinned.current = target   // 点击时锁定
// ...
if (pinned.current !== null) return   // 轮询时跳过
```

### 拖动

按住标题栏拖动，只改变面板自身的 `left`/`top`，不影响原文和选区。边界限制保证至少留 80×40 px 在屏幕内，不会拖丢。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **隐私** | 选中的文本会发送到 Microsoft 的服务器。**含敏感代码或私有信息的段落不要用**。 |
| **非官方端点** | 这是 Edge 浏览器的内部接口，不保证长期可用。可能限流或改格式。 |
| **中国大陆可用性** | 取决于网络能否访问 `edge.microsoft.com`。 |
| **逻辑重复** | 与官方 `dsh-experimental-translator` 实现重叠。 |
| **无缓存** | 同一段文字重复翻译会重复请求（官方方案会把结果存进 Session 日志复用）。 |
| **目标语言固定** | 写死简体中文（`zh-Hans`），不可配置。 |

---

## 调试

### 确认插件是否加载

```js
// 浏览器控制台
document.querySelector('style[data-plugin="@local/dsh-quote-translate"]')  // 应存在
```

### 确认 slot 注册成功

插件管理器里应显示 `application: applied`，无 warning。

### 常见问题

**按钮不出现**
1. 选中文字是否在聊天气泡内？（不是侧边栏、不是输入框）
2. 控制台有无报错？
3. 插件是否 enabled？

**按钮和「引用文本」重叠**
避让逻辑依赖 `[data-text-interaction-surface]` 选择器。如果官方改了 DOM 结构，需要同步更新 `QUOTE_BUTTON_SELECTOR`。

**翻译无响应**
- 检查网络能否访问 `edge.microsoft.com`
- Network 面板看请求是否被 CORS 拦截
- 20 秒超时会显示「翻译超时」

---

## 重新安装

修改代码后需要重新加载：

```
plugin_manager(action="set_bundle", target="@local/dsh-quote-translate", enabled=false)
plugin_manager(action="set_bundle", target="@local/dsh-quote-translate", enabled=true)
```

或者直接在插件面板里关掉再打开。**Client 代码改动需要刷新页面**才生效。

首次安装：

```
plugin_manager(action="install_bundle", target="<绝对路径>/quote-translate")
```
