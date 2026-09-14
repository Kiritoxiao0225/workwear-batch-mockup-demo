export type RepairPoint = [number,number];
export type RepairStroke = {mode:'reset'} | {mode:'fill';scope:'region'|'brush';point:RepairPoint;radius?:number} | {mode:'keep'|'remove';radius:number;points:RepairPoint[]};
export function applyRepairStroke(target:Uint8ClampedArray,source:Uint8ClampedArray,original:Uint8ClampedArray,width:number,height:number,stroke:RepairStroke):{restoredPixels:number}|undefined;
export function validateRepairStrokes(strokes:RepairStroke[],width:number,height:number):void;
