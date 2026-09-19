/**
 * 站点适配器注册入口。
 */
import { registerAdapter } from '../core/registry.js';
import { maccmsStuiAdapter } from './maccms-stui.js';
import { jsvarPlayAdapter } from './jsvar-play.js';

registerAdapter(maccmsStuiAdapter);
registerAdapter(jsvarPlayAdapter);
