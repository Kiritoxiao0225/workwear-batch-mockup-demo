import { randomUUID } from 'node:crypto';
import type { PlannedStep } from '../domain/contracts';
import type { StoredRun, StoredStep, StepOutput, OutputImage } from './runtime-types';
import { claim, completedOutput, heartbeat } from '../adapters/postgres';
import { readOrder, readSteps, updateRun, writeStep } from '../adapters/postgres';
import { combine, composeGarment, crop, imageBytes, removeExterior, renderText, sha256, storePng } from '../adapters/images';
const inputHash = (run: StoredRun, step: PlannedStep) => sha256(JSON.stringify({ version: 'offline-executor-1', plan: run.plan.artworkHash, step }));
async function inputs(run: StoredRun, step: PlannedStep, steps: StoredStep[]): Promise<OutputImage[]> {
    const order = await readOrder(run.orderId);
    if (!order)
        throw new Error('源任务已不存在');
    const images: OutputImage[] = [];
    for (const input of step.inputs) {
        if (input.kind === 'artifact') {
            if (sha256(await imageBytes(input.artifactId)) !== input.sha256)
                throw new Error('步骤输入文件 SHA 不一致');
            images.push({ artifactId: input.artifactId, componentId: null });
            continue;
        }
        if (input.kind === 'step-output') {
            const output = completedOutput(steps, input.stepId);
            if (!output)
                throw new Error(`前置步骤未完成：${input.stepId}`);
            images.push(...output.images);
            continue;
        }
        const use = run.requirement.materialUses.find(u => u.id === input.useId);
        if (!use)
            throw new Error('步骤引用了不存在的素材用途');
        if (use.role === 'excluded' || use.role === 'annotation')
            continue;
        const material = order.source.materials.find(m => m.id === use.materialId);
        if (!material?.artifactId)
            throw new Error('所需原图未就绪');
        if (sha256(await imageBytes(material.artifactId)) !== material.sha256)
            throw new Error('来源文件与登记 SHA 不一致');
        if (use.sourceArtifactSha256 && material.sha256 !== use.sourceArtifactSha256)
            throw new Error('素材内容与需求版本不一致');
        images.push({ artifactId: material.artifactId, componentId: use.role === 'content' ? (use.componentId ?? step.componentIds[0] ?? null) : null });
    }
    return images.filter((image, index) => images.findIndex(other => other.artifactId === image.artifactId && other.componentId === image.componentId) === index);
}
async function executeStep(run: StoredRun, step: PlannedStep, steps: StoredStep[]): Promise<StepOutput> {
    const artwork = run.requirement.artworks.find(a => a.id === run.artworkId);
    if (!artwork)
        throw new Error('图稿要求不存在');
    const source = await inputs(run, step, steps);
    if (step.execution === 'provider' && !['enhance', 'cutout', 'inspect-source', 'review'].includes(step.kind))
        throw new Error('该步骤需要真实图片服务，本地模式不会用模拟图片冒充生成结果');
    if (step.kind === 'inspect-source')
        return { images: source, note: '使用人工标注的离线需求；原图读取已完成，未调用视觉理解' };
    if (step.kind === 'select') {
        const out: OutputImage[] = [];
        for (const input of step.inputs) {
            if (input.kind !== 'material-use')
                continue;
            const use = run.requirement.materialUses.find(u => u.id === input.useId)!;
            if (use.role !== 'content')
                continue;
            const found = source.find(s => s.componentId === (use.componentId ?? step.componentIds[0]));
            if (!found)
                throw new Error('选区没有对应原图');
            if (use.selection.kind === 'unknown')
                throw new Error('选区未知，不自动使用整张截图');
            if (use.selection.kind === 'whole')
                out.push(found);
            else {
                const artifact = await storePng(await crop(await imageBytes(found.artifactId), use.selection.region), '原图选区');
                out.push({ artifactId: artifact.id, componentId: use.componentId });
            }
        }
        return { images: out.length ? out : source, note: '按明确素材身份和选区取材' };
    }
    if (step.kind === 'render-text') {
        const result: OutputImage[] = [], text: string[] = [];
        for (const id of step.componentIds) {
            const component = artwork.components.find(c => c.id === id);
            if (component?.kind !== 'text')
                throw new Error('排字步骤指向非文字组件');
            const file = await storePng(await renderText(component), '准确文字组件');
            result.push({ artifactId: file.id, componentId: id });
            if (component.content.kind === 'exact')
                text.push(component.content.value);
        }
        return { images: result, note: '从准确字符确定性排版；实际字体 DOUYINSANSBOLD / douyin-sans（可能为后备字体）；未调用图像生成', text: text.join('\n') };
    }
    if (step.kind === 'enhance') {
        if (artwork.enhancement === 'disabled')
            return { images: source, note: '本次离线要求禁用增强，保留原始像素' };
        throw new Error('高清增强供应商尚未接通；不能用插值放大冒充增强');
    }
    if (step.kind === 'edit') {
        const mutations = artwork.changes.filter(c => step.authorizedChangeIds.includes(c.id) && c.action.kind !== 'add-component');
        if (mutations.length)
            throw new Error('本地执行器尚不支持这项图片编辑，保留原图待接入');
        return { images: source, note: '原图保留；新增文字由独立组件制作' };
    }
    if (step.kind === 'cutout') {
        const result: OutputImage[] = [];
        for (const item of source) {
            const file = await storePng(await removeExterior(await imageBytes(item.artifactId), artwork.background), '去外底候选');
            result.push({ artifactId: file.id, componentId: item.componentId });
        }
        return { images: result, note: '离线规则仅移除边界连通的均匀外底；保留内部像素，仍需视觉核对' };
    }
    if (step.kind === 'compose-artwork') {
        const components = [];
        for (const component of artwork.components) {
            const image = [...source].reverse().find(s => s.componentId === component.id);
            if (!image)
                throw new Error(`图稿缺少必要组件：${component.id}`);
            components.push({ id: component.id, bytes: await imageBytes(image.artifactId) });
        }
        const file = await storePng(await combine(components, artwork.layout), '完整独立图稿', 'artwork');
        return { images: [{ artifactId: file.id, componentId: artwork.id }], note: '全部必要组件已经合成；保存不代表图片已人工确认' };
    }
    if (step.kind === 'review')
        return { images: source, note: '本地渲染与文件检查已执行；未进行模型图像核对', checks: run.plan.checks.map(check => ({ category: check.category, expected: check.expected, status: 'uncertain', actual: '需要对照实际原图及结果核查；本地未调用视觉核对服务' })) };
    throw new Error(`尚未接通的步骤：${step.kind}`);
}
async function perform(run: StoredRun, step: PlannedStep, work: () => Promise<StepOutput>) {
    const existing = (await readSteps(run.id)).find(s => s.id === step.id);
    if (existing?.status === 'completed' && existing.inputHash === inputHash(run, step))
        return existing.output!;
    const record: StoredStep = { id: step.id, runId: run.id, kind: step.kind, status: 'running', inputHash: inputHash(run, step), output: existing?.output ?? null, error: null,
        startedAt: new Date().toISOString(), finishedAt: null, executions: (existing?.executions ?? 0) + 1 };
    await writeStep(run, record);
    try {
        if (run.failAt === step.kind && !run.faultConsumed) {
            await updateRun(run, { faultConsumed: true });
            throw new Error('本地恢复测试：模拟后续步骤失败，已完成图片已保留');
        }
        const output = await work();
        await writeStep(run, { ...record, status: 'completed', output, finishedAt: new Date().toISOString() });
        return output;
    }
    catch (error) {
        await writeStep(run, { ...record, status: 'failed', error: error instanceof Error ? error.message : '步骤执行失败', finishedAt: new Date().toISOString() });
        throw error;
    }
}
export async function executeRun(run: StoredRun) {
    let leaseError: unknown = null;
    const timer = setInterval(() => { void heartbeat(run).catch(error => { leaseError = error; }); }, 8000);
    try {
        for (const step of run.plan.steps) {
            if (leaseError)
                throw leaseError;
            const steps = await readSteps(run.id);
            for (const dependency of step.dependsOn)
                if (!completedOutput(steps, dependency))
                    throw new Error(`前置步骤未完成：${dependency}`);
            const output = await perform(run, step, () => executeStep(run, step, steps));
            if (step.id === run.plan.outputStepId) {
                if (output.images.length !== 1)
                    throw new Error('最终图稿必须有唯一输出');
                await updateRun(run, { artworkArtifactId: output.images[0].artifactId });
            }
        }
        const order = await readOrder(run.orderId);
        if (!order || !run.artworkArtifactId)
            throw new Error('缺少上衣输入或完整图稿');
        const applications = run.requirement.applications.filter(a => a.artworkId === run.artworkId);
        if (applications.length === 0) {
            await updateRun(run, { error: null }, 'completed');
            return;
        }
        if (applications.length !== 1)
            throw new Error('本地最小链路仅支持单一上衣应用；独立图稿已保留，多应用尚待接入');
        const placement = applications[0].placement;
        if (!placement.baseAssetId || !placement.baseAssetSha256)
            throw new Error('上衣底图未确定；独立图稿已保留');
        const mockup: PlannedStep = { id: 'local-mockup', kind: 'compose-mockup', componentIds: [], dependsOn: [run.plan.outputStepId], inputs: [], instruction: '示例底图与示例位置的离线合成', authorizedChangeIds: [], checkIds: [], execution: 'local', reason: '验证图稿到服装预览的完整链路', condition: 'always' };
        const output = await perform(run, mockup, async () => {
            const file = await storePng(await composeGarment(await imageBytes(placement.baseAssetId!), await imageBytes(run.artworkArtifactId!), placement), '本地服装合成示意', 'mockup');
            return { images: [{ artifactId: file.id, componentId: null }], note: '示例底图和位置，不代表订单真实款式、尺寸或已定稿' };
        });
        await updateRun(run, { mockupArtifactId: output.images[0].artifactId, error: null }, 'completed');
    }
    catch (error) {
        if (!leaseError)
            await updateRun(run, { error: error instanceof Error ? error.message : String(error) }, 'failed');
    }
    finally {
        clearInterval(timer);
    }
}
export async function tick(workerId: string = randomUUID()) { const run = await claim(workerId); if (!run)
    return false; await executeRun(run); return true; }
