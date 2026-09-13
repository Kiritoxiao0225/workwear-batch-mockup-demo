// Current intake scope follows WPS status only. Modification count is deliberately ignored.
// This experimental filter does not write to WPS or change production synchronization.
export function classifyWpsScope({ status }) {
  const normalizedStatus = String(status ?? '').trim().replace(/^[^\p{Script=Han}A-Za-z0-9]+/u, '').trim();
  if (!['待领取', '未领取'].includes(normalizedStatus)) return {
    stage: 'status_excluded', normalizedStatus,
    reason: `WPS状态为“${status || '未填'}”，本轮只取待领取或未领取。`,
  };
  return { stage: 'first_generation', normalizedStatus, reason: `WPS状态为${normalizedStatus}，纳入当前首次制作；不附加修改次数条件。` };
}
