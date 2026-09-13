import path from 'node:path';
/** A separate opt-in runtime. It never reads CATALOG_* or other production configuration. */
export function localConfig() {
    if (process.env.BATCH_MOCKUP_MODE !== 'offline')
        throw new Error('新工作台当前仅提供显式启用的本地验收环境');
    const raw = process.env.BATCH_MOCKUP_DATABASE_URL;
    const objects = process.env.BATCH_MOCKUP_OBJECT_ROOT;
    const projectRoot = process.env.BATCH_MOCKUP_PROJECT_ROOT;
    const origin = process.env.BATCH_MOCKUP_ORIGIN;
    if (!raw || !objects || !projectRoot || !origin)
        throw new Error('本地验收配置不完整，请使用 batch:dev 启动');
    const url = new URL(raw), web = new URL(origin);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['127.0.0.1', 'localhost'].includes(web.hostname))
        throw new Error('本地验收禁止连接外部数据库或监听外部工作台');
    if (!path.isAbsolute(objects) || !path.isAbsolute(projectRoot))
        throw new Error('本地对象与项目目录必须是绝对路径');
    return { databaseUrl: raw, objects, projectRoot, origin: web.origin, faultTesting: process.env.BATCH_MOCKUP_FAULT_TESTING === '1' };
}
