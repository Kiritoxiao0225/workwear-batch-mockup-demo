// Evidence records describe integrations, not a promise of image quality.
// C must register and accept an executor before any plan may be executed.
export const capabilities = {
  version: 'b-capabilities-v2',
  operations: [
    { id: 'reuse', operation: 'reuse', provider: 'local', implementation: 'Sharp', evidence: 'batch-mockup/adapters/images.ts', boundary: '只读取或明确裁切，不恢复细节、不改变图形', cReady: false },
    { id: 'render-text', operation: 'render-text', provider: 'local', implementation: 'Canvas + checked font', evidence: 'batch-mockup/adapters/images.ts', boundary: '实际字体覆盖；直排或单行弧形；不能用默认字体冒充参考字形', cReady: false },
    { id: 'compose', operation: 'compose', provider: 'local', implementation: 'Sharp', evidence: 'batch-mockup/adapters/images.ts', boundary: '仅组合/明确画布需求才使用；按坐标等比放置，默认透明画布，白底需明确授权；不去除输入已有背景；新C适配待接', cReady: false },
    { id: 'enhance-mediakit', operation: 'enhance', provider: 'MediaKit', implementation: '/api/v1/tools-sync/enhance-image', evidence: 'lib/server/media-kit-artwork.ts', boundary: '旧接入为2倍professional/fidelity_first；真实保真效果及新C接入待验', cReady: false },
    { id: 'generate-cliproxy', operation: 'generate', provider: 'CLIProxy', implementation: 'gpt-image-2 / images/edits or images/generations', evidence: 'lib/server/cliproxy-image-2.ts', boundary: '旧接入2048x2048/medium；不保证文字和Logo保真，新C待验；不是本机AI模型', cReady: false },
    { id: 'cutout-meitu', operation: 'cutout', provider: 'Meitu', implementation: 'image-cutout / model_type:2', evidence: 'lib/server/meitu-cutout.ts', boundary: '图标/印章路线待用真实Logo验收；不得把桌面软件效果等同接口结果', cReady: false },
    { id: 'cutout-mediakit', operation: 'cutout', provider: 'MediaKit', implementation: '/api/v1/tools-sync/remove-image-background', evidence: 'lib/server/media-kit-artwork.ts', boundary: '旧接入product/general；具体后端与火山能力关系及新C效果待核实', cReady: false },
  ],
  excluded: [
    { name: '本地颜色去底', reason: '仅旧离线演示，已发现破坏图案的风险，不向规划器提供' },
    { name: '美图生图/本地AI生图', reason: '未核实项目实际生成接入，不虚构可执行API' },
  ],
};
