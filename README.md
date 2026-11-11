# dsh-ui-enhance

dsh（DeepSeek Harness Desktop）的界面增强插件。给会话加一层统一的视觉与信息层：上下文预算环、手动压缩、侧栏上下文进度、磨砂玻璃面板、ShaderToy 动态背景，以及一套作用于**所有面板**的统一透明度 / 模糊参数。

当前版本：`0.9.35`（`@local/ui-enhance`）

---

## 功能

### 上下文与用量

| 功能 | 说明 |
|---|---|
| 上下文档位切换 | 每会话独立选择 200K / 400K / 800K / 1M |
| 上下文占用环 | 输入框左侧悬浮，显示本轮与本会话的 token 消耗 |
| 手动压缩 | 按钮直接触发压缩，不必等自动阈值 |
| 侧栏上下文进度条 | 每个会话一条随占用变大的进度条 |
| 费用与额度 | 本轮 / 本会话的费用估算、中转站剩余额度 |
| 本地时间 | 侧栏底部常驻 |

### 外观

- **磨砂玻璃面板**：侧栏、正文、右侧栏统一走 `.ue-col` 的 `backdrop-filter`。
- **ShaderToy 背景**：内置在线拉取（默认 `Wl2Gzc` "Flat water effects 2"）+ 本地代码编辑，可切换预设。
- **统一窗口参数**：透明度与模糊由一个滑杆对所有面板同时生效（见下）。

### 性能

性能档位只改**渲染分辨率**，帧率恒为 60 fps：

| 档位 | 渲染分辨率 | 帧率 |
|---|---|---|
| 高 | 100% | 60 fps |
| 中 | 50% | 60 fps |
| 低 | 25% | 60 fps |

帧率不再随档位下降——背景动画跑在 30 fps 时在 60 Hz 屏上会看到明显抖动。降负载的杠杆是分辨率，不是帧率。

> 帧率闸门带 2 ms 余量：60 Hz 屏上 rAF 时间戳会略小于 16.67 ms，严格比较会跳过每隔一帧、把背景砍到 30 fps。

---

## 统一透明 / 模糊参数

所有面板共用两个 CSS 变量，挂在 `<html>` 上：

| 变量 | 插件默认 | CSS 兜底 | 作用 |
|---|---|---|---|
| `--ue-win-alpha` | `62%` | `32%` | 面板底色不透明度 |
| `--ue-win-blur` | `0px` | `18px` | 面板背后内容的模糊半径 |

生效前提是 `<html>` 带 `ue-window-on` 类（美化总开关为 `ue-beautify-on`）。

```css
html.ue-window-on .ue-col {
  background-color: color-mix(in srgb, var(--dsw-alias-bg-base) var(--ue-win-alpha, 32%), transparent) !important;
  backdrop-filter: blur(var(--ue-win-blur, 18px)) saturate(215%) brightness(1.10) !important;
}
```

**设计约束**：任何面板里的卡片、区块都不许自己画不透明底色——底色只能来自列自身的那一层 tint。否则该卡片会无视滑杆，读起来像一块黑板。插件里对所有已知的卡片类名都强制了 `background-color: transparent`。

> 已知取舍：`--ue-win-blur` 为 `0px` 时面板会如实透出背景。如果背景图下半部偏暗，正文底部会看起来像有一条自下而上的黑边——那是背景本身，不是被画出来的元素。拉高 `背景模糊` 或 `窗口不透明度` 即可消除。

---

## 安装

dsh 通过 profile 的 `package.json` 挂载插件，插件目录本身用 `link:` 引用，不需要发布到 npm。

1. 把本仓库放到 dsh 的 `UI` 目录下，例如 `<dsh>\UI\ui-enhance`。

2. 在 profile 的 `package.json`（默认 `%USERPROFILE%\.dsh\profiles\desktop\package.json`）里登记：

   ```jsonc
   {
     "dsh": {
       "profile": {
         "bundles": [
           // ...
           "@local/ui-enhance"
         ]
       }
     },
     "dependencies": {
       "@local/ui-enhance": "link:E:/path/to/UI/ui-enhance"
     }
   }
   ```

3. 在 profile 的 `cordis.patch.yml` 里插入节点：

   ```yaml
   - insert:
       - id: ui-enhance
         name: '@local/ui-enhance'
   ```

4. 重启 dsh。

### 开发时

- `client.js` **保存即热重载**，改完存盘几秒内生效；不需要重启。
- 但**从别的机器 scp 覆盖上去不一定触发**。判据：CDP 里把所有 `<style>` 的文本拼起来，搜你新加的选择器；0 命中就是没换。触发手段是在 Windows 侧原地重写一遍文件：

  ```powershell
  $p = 'E:\...\ui-enhance\client.js'
  [IO.File]::WriteAllText($p, [IO.File]::ReadAllText($p))
  ```

- `index.js`（宿主侧）**不热重载**，要重开插件。
- **热重载进带未定义符号的版本会让渲染进程卡死**（100% 单核、GPU 0%、画面冻结但 agent 仍在跑），此时只能重启 dsh。改完先跑语法检查。

---

## 目录

```
client.js          浏览器半：所有 UI、样式规则、ShaderToy 渲染循环
index.js           宿主半：路由、会话数据、额度查询
shadertoy.mjs      ShaderToy 拉取与本地代码编辑
cordis.patch.yml   profile 补丁
locale/            zh / en 文案
icon.svg
```

## 许可

未声明。仓库公开发布仅作分享，未附授权条款。
