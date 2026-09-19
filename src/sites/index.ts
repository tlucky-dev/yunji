/**
 * 站点适配器注册入口。
 */
import { registerAdapter } from '../core/registry.js';
import { maccmsStuiAdapter } from './maccms-stui.js';

registerAdapter(maccmsStuiAdapter);
