const SITE_CONFIGS = {
  deepseek: {
    key: "deepseek",
    name: "DeepSeek",
    url: "https://chat.deepseek.com/",
    inputText: "Message DeepSeek",
    description: "Expert mode + DeepThink ON",
    steps: [
      { label: "Select Expert mode", find: "Expert" },
      {
        label: "Enable DeepThink",
        find: "DeepThink",
        type: "toggle",
        activeProbe: { text: "DeepThink", cls: "ds-toggle-button--selected" }
      }
    ]
  },
  qwen: {
    key: "qwen",
    name: "Qwen",
    url: "https://chat.qwen.ai/",
    inputText: "How can I help you today?",
    description: "Switch to Qwen3.8-Max-Preview",
    steps: [
      { label: "Open model picker", find: "Select Model" },
      { label: "Expand more models", find: "Expand more models", optional: true },
      { label: "Pick Qwen3.8-Max-Preview", find: "Qwen3.8-Max-Preview" }
    ]
  },
  gemini: {
    key: "gemini",
    name: "Gemini",
    url: "https://gemini.google.com/app",
    inputText: "Enter a prompt for Gemini",
    description: "Pick model + Extended thinking",
    models: ["3.5 Flash-Lite", "3.6 Flash", "3.1 Pro"],
    steps: [
      { label: "Open mode picker", find: "mode picker" },
      {
        label: "Select 3.1 Pro",
        find: "3.1 Pro",
        modelStep: true,
        openMenu: "mode picker",
        pauseAfter: 1200
      },
      {
        label: "Enable Extended thinking",
        find: "Extended thinking",
        type: "toggle",
        activeProbe: { text: "Extended", cls: "input-area-switch" },
        openMenu: "mode picker",
        openWait: 800,
        timeout: 25000,
        pauseAfter: 1000
      }
    ]
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
