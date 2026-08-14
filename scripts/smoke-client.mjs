/**
 * dsh-attachment-formats — 客户端 bundle 冒烟（Node vm 沙箱模拟浏览器）。
 *
 * 验证 lib/client.js 能作为 window.__ModuleLoader__ 模块加载，且 apply(ctx)
 * 能在最小 slots/effect/document 桩上完整执行（插槽注册 + 拖放/粘贴监听），
 * 不真正渲染 React。运行：npm run smoke:client
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

let failures = 0;
function check(label, ok, extra = "") {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label} ${extra}`);
  }
}

// ---- 浏览器环境桩 --------------------------------------------------------
const documentListeners = [];
const HTMLTextAreaElementStub = function HTMLTextAreaElement() {};
let queriedTextarea = null; // 可切换的假输入框
const documentStub = {
  getElementById: () => null,
  createElement: (tag) => ({ tagName: tag, textContent: "", dataset: {} }),
  head: { appendChild: () => {} },
  querySelector: () => queriedTextarea,
  addEventListener: (type, fn, capture) => documentListeners.push({ type, capture: !!capture, fn }),
  removeEventListener: () => {},
  dispatchEvent: () => true
};
const windowStub = {
  __ModuleLoader__: {
    load({ factory }) {
      windowStub.__loaded = factory((id) => {
        if (id === "react") return React;
        if (id === "react/jsx-runtime") return jsxRuntime;
        if (id === "@deepseek-ai/dsh-client-ui-primitives") {
          return { Tooltip: () => null, IconPaperclipOutline16: () => null };
        }
        throw new Error(`unexpected require: ${id}`);
      });
    }
  },
  addEventListener: () => {},
  dispatchEvent: () => true,
  HTMLTextAreaElement: HTMLTextAreaElementStub,
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  }
};
Object.defineProperty(HTMLTextAreaElementStub.prototype, "value", {
  get() {
    return this._dshafValue ?? "";
  },
  set(next) {
    this._dshafValue = String(next);
  },
  configurable: true
});

const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  },
  DragEvent: class DragEvent {
    constructor(type) {
      this.type = type;
    }
  },
  DataTransfer: class DataTransfer {
    constructor() {
      this.items = { add: () => {} };
    }
  },
  console,
  setTimeout,
  clearTimeout,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  TextDecoder,
  TextEncoder,
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} },
  HTMLTextAreaElement: HTMLTextAreaElementStub
});
try {
  vm.runInContext(source, context, { filename: "client.js" });
  check(
    "client bundle loads",
    typeof windowStub.__loaded === "object" && windowStub.__loaded !== null && typeof windowStub.__loaded.apply === "function"
  );
} catch (error) {
  check("client bundle loads", false, error.stack);
  process.exitCode = 1;
  throw error;
}

const clientModule = windowStub.__loaded;
check("client exports apply/inject", typeof clientModule?.apply === "function" && Array.isArray(clientModule?.inject));

// ---- 假 slots ctx（inject 立即执行声明回调；register 记录选项）--------------
const registered = [];
const ctx = {
  effect(callback) {
    callback();
    return () => {};
  },
  slots: {
    inject(key, callback) {
      callback();
    },
    register(options) {
      registered.push({ key: null, options });
      return () => {};
    }
  }
};
// 让 register 知道归属的 slot：包一层，在回调执行期间记住 key。
const slotKeys = [];
ctx.slots.inject = (key, callback) => {
  slotKeys.push(key);
  try {
    callback();
  } finally {
    slotKeys.pop();
  }
};
ctx.slots.register = (options) => {
  registered.push({ key: slotKeys[slotKeys.length - 1] ?? null, options });
  return () => {};
};

try {
  clientModule.apply(ctx);
  check("apply runs", true);
} catch (error) {
  check("apply runs", false, error.stack);
  process.exitCode = 1;
  throw error;
}

const left = registered.filter((r) => r.key === "conversation.input.left");
const dock = registered.filter((r) => r.key === "conversation.input.dock");
check("input.left registered", left.length === 1 && left[0].options.id === "attach-formats");
check("input.dock registered", dock.length === 1 && dock[0].options.id === "attach-formats");

const drops = documentListeners.filter((l) => l.type === "drop" && l.capture);
const pastes = documentListeners.filter((l) => l.type === "paste" && l.capture);
const keydowns = documentListeners.filter((l) => l.type === "keydown" && l.capture);
const clicks = documentListeners.filter((l) => l.type === "click" && l.capture);
check("drop capture listener", drops.length === 1);
check("paste capture listener", pastes.length === 1);
check("keydown capture listener (send merge)", keydowns.length === 1);
check("click capture listener (send merge)", clicks.length === 1);

// ---- 纯图片 drop 必须放行（不拦截）-----------------------------------------
const fakeImageFile = { name: "a.png", type: "image/png" };
const transferNative = { types: ["Files"], files: [fakeImageFile] };
const evNative = {
  dataTransfer: transferNative,
  preventDefault: () => { evNative.prevented = true; },
  stopImmediatePropagation: () => { evNative.stopped = true; }
};
drops[0].fn(evNative);
check("native-image drop passes through", evNative.prevented !== true && evNative.stopped !== true);

// ---- 含 PDF 的 drop 必须拦截 ------------------------------------------------
let pdfIntakeBusy = false;
const transferPdf = { types: ["Files"], files: [{ name: "报告.pdf", type: "application/pdf" }] };
const evPdf = {
  dataTransfer: transferPdf,
  preventDefault: () => { evPdf.prevented = true; },
  stopImmediatePropagation: () => { evPdf.stopped = true; }
};
pdfIntakeBusy = true;
drops[0].fn(evPdf);
check("pdf drop intercepted", evPdf.prevented === true && evPdf.stopped === true);

// ---- 文档卡片流：拖入 md → 挂芯片（输入框干净）→ Enter 合并进草稿 ----------
{
  const textarea = new HTMLTextAreaElementStub();
  textarea.disabled = false;
  textarea.readOnly = false;
  textarea.setSelectionRange = () => {};
  textarea.dispatchEvent = () => true;
  textarea.focus = () => {};
  queriedTextarea = textarea;
  const mdFile = {
    name: "测试.md",
    type: "text/markdown",
    size: 100,
    arrayBuffer: async () => new TextEncoder().encode("这是附件正文内容 hello").buffer
  };
  const evDropMd = {
    dataTransfer: { types: ["Files"], files: [mdFile] },
    preventDefault: () => {},
    stopImmediatePropagation: () => {}
  };
  drops[0].fn(evDropMd);
  await new Promise((resolve) => setTimeout(resolve, 30));
  check("芯片期：输入框保持干净", textarea.value === "", `got ${JSON.stringify(textarea.value)}`);
  keydowns[0].fn({ key: "Enter", shiftKey: false, target: textarea });
  check(
    "Enter 合并：草稿含附件标记与内容",
    textarea.value.includes("[附件: 测试.md]") && textarea.value.includes("这是附件正文内容")
  );
  const afterFirst = textarea.value;
  keydowns[0].fn({ key: "Enter", shiftKey: false, target: textarea });
  check("二次 Enter 不重复合并", textarea.value === afterFirst);
}

console.log(`\n${failures === 0 ? "客户端冒烟通过 ✅" : `${failures} 项失败 ❌`}`);
if (failures > 0) process.exitCode = 1;
