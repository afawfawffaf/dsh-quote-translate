# dsh-quote-translate

给 DSH Web GUI 加一个划词翻译：**选中聊天里的任意文字，点「翻译」，弹出简体中文译文卡片。**

- 译文显示在可拖动的浮层里，**不改动原文、草稿和会话记录**
- 按钮自动避让官方的「引用文本」，不重叠
- **不消耗任何 LLM token** —— 翻译请求由浏览器直接发往 Microsoft 的匿名端点

```
选中文字  →  点「翻译」  →  译文卡片（可复制 / 可拖动 / Esc 关闭）
```

---

## 安装

需要 DSH 桌面版，且能访问本地 Web GUI。

### 1. 克隆到任意位置

```bash
git clone https://github.com/afawfawffaf/dsh-quote-translate.git
```

### 2. 用插件管理器安装

在 DSH 里让 Agent 执行（把路径换成你的实际路径）：

```
plugin_manager(
  action="install_bundle",
  target="/绝对路径/dsh-quote-translate"
)
```

或者直接把路径告诉 Agent：「用 plugin_manager 安装这个目录下的 bundle」。

### 3. 刷新页面

Client 代码改动需要刷新 Web GUI 才生效。

---

## 使用

1. 在**聊天气泡**里选中一段文字
2. 点旁边的「翻译」
3. 译文卡片弹出

| 操作 | 方式 |
|---|---|
| 复制译文 | 点卡片里的「复制」 |
| 移动卡片 | 按住标题栏拖动 |
| 关闭卡片 | 点 ✕ 或按 `Esc` |

按钮会自动避让「引用文本」：检测到它就排在右侧，右侧空间不够时翻到左侧。

---

## 卸载

```
plugin_manager(action="remove_bundle", target="@local/dsh-quote-translate")
```

---

## 实现原理

### 为什么没有后端

最初的方案是标准的 Host + Client 两段式：Host 侧调官方 `ctx.translator`，Client 侧通过 Remote 调用。

**但这条路在桌面版走不通。** DSH 把官方包全部打包在 `app.asar` 内：

```
resources/app.asar          ← 官方包在这里
resources/app.asar.unpacked/
```

已安装的 workspace bundle 是 symlink，Node 从 workspace 解析依赖，而那里没有这些包：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-typert-protocol'
```

所以改为浏览器直连。该端点 CORS 完全放开（`Access-Control-Allow-Origin: *`），实测可用：

```bash
curl -X POST "https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false" \
  -H "Content-Type: application/json" \
  -d '["Hello world, this is a test."]'

# [{"translations":[{"text":"世界好，这是个测试。","to":"zh-Hans"}]}]
```

### 为什么用 `shell.overlay`

这是开发中最大的坑。

官方「引用文本」占用的 `conversation.chat.text-interaction` 是 **`keyed`** 类型：

```js
"conversation.chat.text-interaction": {
  kind: "keyed",
  scope: "session"
}
```

而 keyed slot 的渲染逻辑用的是 `find`：

```js
if (spec.kind === "keyed") {
  const entry = host.entriesOfSlot(slotKey)
    .find((e) => e.options.key === opts?.entryKey)
```

**`find` 只返回第一个匹配项**，`entryKey` 是获胜 interaction 的 id（固定为 `'quote'`）。于是：

| 注册的 key | 结果 |
|---|---|
| `key: 'translate'` | 找不到 → 不渲染 |
| `key: 'quote'` | 命中官方先注册的 → 仍不渲染自己 |

**这个 slot 从设计上只能容纳一个 action。** 改用 `shell.overlay`（`kind: "list"`，渲染所有注册项）后，浮层才能独立存在。

### slot 类型速查

选扩展点前先查这张表：

| kind | 渲染行为 | 多插件共存 |
|---|---|---|
| `single` | 取 `[0]` | ❌ |
| `keyed` | `find(key)` | ❌ |
| `list` | `map` + 按 `order` 排序 | ✅ |
| `chain` | 遍历 `select()` 择一 | ⚠️ |

### 关键实现点

**选区过滤**：只认 `[data-text-interaction-source]`（聊天正文）内的选区，排除输入框内的选区。

**避让逻辑**：检测 `[data-text-interaction-surface]` 的位置来排布按钮；因为它是异步挂载的，用 400ms 轮询重新定位。

**长文本分片**：单次请求上限 1800 字符，按 `\n\n` → `\n` → 空格 → 硬切 的优先级切分，切分点若落在 UTF-16 代理对中间会回退一位。

**点击后面板不消失**：点击会让浏览器清除选区，进而触发 `selectionchange` 导致卸载。用 `pinned` ref 锁住已捕获的选区，直到面板关闭才释放。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **隐私** | 选中的文本会发送到 Microsoft 服务器。**含敏感代码或私有信息的段落请勿使用。** |
| **非官方端点** | 这是 Edge 浏览器的内部接口，可能限流或改格式，不保证长期可用。 |
| **网络** | 需要能访问 `edge.microsoft.com`，中国大陆可用性取决于网络环境。 |
| **无缓存** | 同一段文字重复翻译会重复请求。 |
| **语言固定** | 写死简体中文（`zh-Hans`），不可配置。 |
| **仅桌面版** | 依赖 `app.asar` 的部署形态，其他安装方式未测试。 |

---

## 文件结构

| 文件 | 作用 |
|---|---|
| `client.js` | 全部实现：选区监听、按钮、面板、翻译、i18n |
| `index.js` | Host 入口，空实现（无 Host 半部分） |
| `cordis.patch.yml` | 插入一行 plugin row |
| `package.json` | bundle 清单 + client 入口声明 |
| `locale/{zh,en}.json` | 插件管理器显示的标题与描述 |
| `icon.svg` | 插件图标 |

---

## 调试

确认插件已加载：

```js
// 浏览器控制台
document.querySelector('style[data-plugin="@local/dsh-quote-translate"]')
```

| 现象 | 排查 |
|---|---|
| 按钮不出现 | 选区是否在聊天气泡内？控制台有无报错？插件是否 enabled？ |
| 与「引用文本」重叠 | 避让依赖 `[data-text-interaction-surface]`，官方若改 DOM 需同步更新选择器 |
| 翻译无响应 | 检查能否访问 `edge.microsoft.com`；Network 面板看是否被 CORS 拦截 |

---

## License

MIT
