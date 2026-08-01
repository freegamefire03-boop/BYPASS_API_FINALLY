const SITE_CONFIGS = {
  deepseek: {
    key: "deepseek",
    name: "DeepSeek",
    url: "https://chat.deepseek.com/",
    inputText: "Message DeepSeek",
    options: [
      { key: "mode", label: "Mode", values: ["Instant", "Expert", "Vision"], default: "Expert" },
      { key: "deepThink", label: "DeepThink", type: "toggle", default: true },
      { key: "search", label: "Web search", type: "toggle", default: true }
    ],
    describe(sel) {
      return (
        sel.mode +
        " mode \u00b7 DeepThink " +
        (sel.deepThink ? "ON" : "OFF") +
        " \u00b7 Search " +
        (sel.search ? "ON" : "OFF")
      );
    },
    buildSteps(sel) {
      const toggle = (label, find, on, optional) => ({
        label: (on ? "Enable " : "Disable ") + label,
        find,
        type: "toggle",
        target: on ? "on" : "off",
        activeProbe: { text: find, cls: "ds-toggle-button--selected" },
        optional: optional || false,
        pauseAfter: 900
      });
      return [
        { label: "Select " + sel.mode + " mode", find: sel.mode, pauseAfter: 1500 },
        toggle("DeepThink", "DeepThink", sel.deepThink),
        toggle("Web search", "Search", sel.search, true)
      ];
    }
  },
  qwen: {
    key: "qwen",
    name: "Qwen",
    url: "https://chat.qwen.ai/",
    inputText: "How can I help you today?",
    options: [
      {
        key: "model",
        label: "Model",
        values: ["Qwen3.7-Plus", "Qwen3.7-Max", "Qwen3.8-Max-Preview"],
        default: "Qwen3.7-Plus"
      },
      {
        key: "reasoning",
        label: "Thinking",
        values: ["Auto", "Thinking", "Fast"],
        default: "Auto"
      }
    ],
    describe(sel) {
      return sel.model + " \u00b7 thinking " + sel.reasoning;
    },
    buildSteps(sel) {
      return [
        { label: "Open model picker", find: "Select Model", pauseAfter: 600 },
        { label: "Expand more models", find: "Expand more models", optional: true, pauseAfter: 600 },
        { label: "Pick " + sel.model, find: sel.model, pauseAfter: 1500 },
        {
          label: "Set thinking " + sel.reasoning,
          type: "dropdown",
          openCss: ".qwen-select-thinking .ant-select-selector",
          optionCss: ".ant-select-item-option",
          find: sel.reasoning,
          currentCss: ".qwen-select-thinking .ant-select-selection-item",
          optional: true,
          pauseAfter: 1000
        }
      ];
    }
  },
  gemini: {
    key: "gemini",
    name: "Gemini",
    url: "https://gemini.google.com/app",
    inputText: "Enter a prompt for Gemini",
    options: [
      { key: "model", label: "Model", values: ["3.5 Flash-Lite", "3.6 Flash", "3.1 Pro"], default: "3.1 Pro" },
      { key: "thinking", label: "Extended thinking", type: "toggle", default: true }
    ],
    describe(sel) {
      return sel.model + " \u00b7 " + (sel.thinking ? "Extended thinking" : "No extended thinking");
    },
    buildSteps(sel) {
      return [
        { label: "Open mode picker", find: "mode picker" },
        {
          label: "Select " + sel.model,
          find: sel.model,
          openMenu: "mode picker",
          pauseAfter: 1200
        },
        {
          label: (sel.thinking ? "Enable" : "Disable") + " Extended thinking",
          find: "Extended thinking",
          type: "toggle",
          target: sel.thinking ? "on" : "off",
          activeProbe: { text: "Extended", cls: "input-area-switch" },
          openMenu: "mode picker",
          openWait: 800,
          timeout: 25000,
          pauseAfter: 1000
        }
      ];
    }
  },
  kimi: {
    key: "kimi",
    name: "Kimi",
    url: "https://www.kimi.com/?chat_enter_method=change_model",
    inputText: 'Type "/" to invoke plugins and skills',
    description: "Instant + High thinking effort",
    steps: [
      { label: "Open mode menu", find: "Instant" },
      { label: "Hover Thinking effort", type: "hover", find: "Thinking effort" },
      { label: "Pick High", find: "High" }
    ]
  },
  zai: {
    key: "zai",
    name: "Z.ai (GLM)",
    url: "https://chat.z.ai/",
    inputText: "Select a model",
    description: "GLM-5.2 + Max + Deep Think",
    steps: [
      { label: "Open Deep Think", find: "Deep Think", keyboard: true },
      { label: "Pick Max", find: "Max" }
    ]
  }
};

if (typeof window !== "undefined") {
  window.SITE_CONFIGS = SITE_CONFIGS;
}
