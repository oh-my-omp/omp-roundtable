import {tr} from '../i18n.ts';
import type {RuntimeError} from './controller.ts';

/** Detailed protocol diagnostics remain in the log; notifications render their structured category. */
export function runtimeErrorText(error:RuntimeError):string {
  const detail=tr('See the Roundtable runtime error in the log for diagnostic details.','诊断详情请查看日志中的圆桌运行错误。');
  switch(error.kind){
    case 'domain':return tr(`Roundtable: ticket operation failed (${error.error.kind}). ${detail}`,`圆桌：工单操作失败（${error.error.kind}）。${detail}`);
    case 'storage':return tr(`Roundtable: durable state failed (${error.error.kind}). ${detail}`,`圆桌：持久状态操作失败（${error.error.kind}）。${detail}`);
    case 'source':return tr(`Roundtable: source request failed (${error.error.kind}). ${detail}`,`圆桌：源头请求失败（${error.error.kind}）。${detail}`);
    case 'host':return tr(`Roundtable: seat host failed (${error.error.kind}). ${detail}`,`圆桌：席位宿主操作失败（${error.error.kind}）。${detail}`);
    case 'workflow':return tr(`Roundtable: workflow could not be loaded (${error.error.source}). ${detail}`,`圆桌：无法加载工作流（${error.error.source}）。${detail}`);
  }
}
