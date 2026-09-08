import Link from 'next/link';

export default function WpsConnectPage() {
  return <main style={{ maxWidth: 800, margin: '48px auto', padding: 24, lineHeight: 1.9 }}>
    <Link href="/wps-production">← 返回效果图生产表</Link>
    <h1>连接客户的原表</h1>
    <p>使用原表里的 JS 脚本读取需求、素材图片和状态，并写回状态。此连接使用脚本令牌，不需要原来的应用 ID、密钥或 OAuth 回调地址。</p>
    <p><a href="https://365.kdocs.cn/view/l/cj5Qvp0WVtjz" target="_blank" rel="noreferrer">打开客户原表：【测试】效果图任务管理系统v3.5</a></p>
    <ol>
      <li><strong>确认操作账号具有原表编辑权限。</strong>当前“小丰”账号已开通编辑权限；如果客户要自己管理接入，也可以由客户完成以下步骤。</li>
      <li><strong>在原表添加接入脚本。</strong>打开“更多 → 脚本 → AirScript脚本 → 新建脚本”，将下方文件的全部内容粘贴进去，命名为“效果图项目接入”并保存。如果该脚本已经存在，直接使用它。直接运行一次只检查表结构，不会改动记录。</li>
      <li><strong>提供脚本的调用信息。</strong>在该脚本的菜单中“复制脚本 Webhook”；在编辑器工具栏打开“脚本令牌”，按 WPS 提示创建或使用现有令牌。将这两项配置到项目服务端后，即可进行首次同步验证。</li>
    </ol>
    <p><a className="button primary" href="/integrations/wps-task-bridge.txt" download="效果图项目接入脚本.txt">下载可粘贴的接入脚本</a></p>
    <p>脚本固定连接“效果图任务管理”。原表的任务状态由公式计算：领取或退回任务通过已有“领取任务”更新；已完成由交付成品决定，已取消由异常标签决定。修改前检查原文、素材及旧状态，修改后重新读取确认。</p>
    <p>脚本令牌绑定 WPS 账号，可调用该账号有权限的脚本，并非只授权本项目。请仅配置在项目服务端；若 WPS 要求实名认证，请由账号本人完成。</p>
    <p>配置完成后，返回生产表点击“同步 WPS 状态与素材”验证真实数据。页面可见且未编辑时每 30 秒自动检查，切回页面立即检查；新增记录自动置顶，补填需求和素材继续更新同一行。未接通时不会展示测试数据。连接缺少的具体信息会显示在生产表中。</p>
    <p><a href="https://open.wps.cn/documents/app-integration-dev/guide/dbsheet/AirScript/script-token/AirScript-apitoken-instro" target="_blank" rel="noreferrer">WPS 官方脚本令牌说明</a></p>
  </main>;
}
