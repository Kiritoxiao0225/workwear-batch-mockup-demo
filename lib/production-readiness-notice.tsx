import type { ReactNode } from 'react';
import type { ProductionUnit, WpsProductionState } from './wps-production';
import { productionPreviewFixed, productionPreviewReadiness } from './production-preview';

export function productionReadinessNotice(unit: ProductionUnit, state: WpsProductionState): ReactNode {
 const ready=productionPreviewReadiness(unit,{fixed:productionPreviewFixed(unit,state.mockupVersions)});
 if (ready.garmentIssue) return <p key={unit.id} className="wps-shared-notice" role="status">{unit.garmentLabel} · 上衣暂不可用：{ready.garmentIssue}。独立图案仍可制作，已保存图稿保留。 <a href={ready.calibrationUrl}>打开该款色核对衣身宽度与位置</a></p>;
 return ready.temporaryPlacement ? <p key={unit.id} className="wps-shared-next">{unit.garmentLabel} · 使用临时预览位置，尚未人工确认；图稿生成后按实际边界核对。</p> : null;
}
