// 工具声明：爆款标题 A/B 生成（自定义界面：批量出标题并打分 / 两组标题对比）。
import { Type as TypeAsIcon } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'c20',
  name: '爆款标题 A/B 生成',
  tagline: '按公众号、小红书、抖音、视频号、B 站的风格批量出候选标题，大模型从吸引力、清晰度、合规风险三方面打分并写理由；也能给你自己的两组标题打分对比，结果导出 Excel。',
  icon: TypeAsIcon,
  category: '内容生产',
  type: 'text',
  mode: 'custom',
  mainLabel: '出标题',
  needsLLM: true,
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
