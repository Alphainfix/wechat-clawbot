/**
 * Evaluation dataset for the automatic memory capture (memory-auto.ts).
 *
 * Each sample: { text, expect } where expect is true when the message
 * contains a durable user fact that SHOULD be captured into memory, and
 * false when it is a task request / greeting / trivial message that should
 * NOT be remembered.
 *
 * Built from real WeChat usage patterns observed in this project.
 */
export const MEMORY_EVAL_CASES: Array<{ text: string; expect: boolean }> = [
  // ── 应该捕获:身份 / 档案 ─────────────────────────────
  { text: "我是一名研究生", expect: true },
  { text: "[微信消息] 我是大学生", expect: true },
  { text: "我在读计算机专业", expect: true },
  { text: "我是做前端开发的", expect: true },
  { text: "我叫 Alex", expect: true },
  { text: "我主要使用中文交流", expect: true },

  // ── 应该捕获:偏好 / 习惯 ─────────────────────────────
  { text: "我以后不喜欢用md文件", expect: true },
  { text: "我希望你回复精简一点", expect: true },
  { text: "我偏好结论先行的回答", expect: true },
  { text: "每次发文件都要先确认", expect: true },
  { text: "以后不要再给我发gif了", expect: true },
  { text: "我喜欢用微信远程操控电脑", expect: true },
  { text: "我习惯晚上十点睡觉", expect: true },
  { text: "我不喜欢装饰性emoji", expect: true },
  { text: "请以后尽量用中文回复", expect: true },

  // ── 应该捕获:长期成立的安排 / 用「记得」引出的事实 ─────
  // 「别忘了 / 记得」本身不是提醒:后面跟的是事实就该记。
  { text: "请记得我对花生过敏", expect: true },
  { text: "别忘了我不吃香菜", expect: true },
  { text: "我每周三下午都有组会", expect: true },

  // ── 不应该捕获:一次性提醒(归 schedule_create) ───────
  // 2026-09-23 之前这三条都是 expect: true —— 分类器当时就是按「记提醒」设计的,
  // 与 bot 自己的记忆规则相矛盾,实测 18 条自动记忆里 16 条是过期提醒。
  // memory.md 每一轮都整份进提示词,一条「明天十点开会」第二天就是错的。
  { text: "请记得提醒我交报告", expect: false },
  { text: "别忘了明天上午十点开会", expect: false },
  { text: "到点提醒我喝水", expect: false },
  { text: "三分钟后提醒我来找你", expect: false },
  { text: "明天晚上10点提醒我做作业", expect: false },
  { text: "记得今晚十一点提醒我备份文件", expect: false },

  // ── 不应该捕获:任务请求 ──────────────────────────────
  { text: "帮我查一下今天的天气", expect: false },
  { text: "把这个文件发给我", expect: false },
  { text: "请帮我搜一下洛克王国的最新时装", expect: false },
  { text: "帮我看看这个是泡泡玛特的什么角色", expect: false },
  { text: "创建 hello.txt 然后发给我", expect: false },
  { text: "请列出桌面的文件", expect: false },
  { text: "帮我设置一个提醒", expect: false },
  { text: "这个文档帮我审阅一下", expect: false },

  // ── 不应该捕获:问候 / 闲聊 / 琐碎 ───────────────────
  { text: "你好", expect: false },
  { text: "在吗", expect: false },
  { text: "谢谢", expect: false },
  { text: "好的", expect: false },
  { text: "哈哈", expect: false },
  { text: "晚安", expect: false },
  { text: "辛苦了", expect: false },

  // ── 不应该捕获:对话性 / 信息查询(非自我陈述) ───────
  { text: "你觉得明天会下雨吗", expect: false },
  { text: "这个多少钱", expect: false },
  { text: "洛克王国在哪里可以玩", expect: false },
  { text: "那是什么", expect: false },
  { text: "你叫什么名字", expect: false },

  // ── 边缘情况 ─────────────────────────────────────────
  { text: "我是想让你帮我查一下价格", expect: false }, // "我是"后接任务,非身份陈述
  { text: "我是说那个文件", expect: false }, // 指代性"我是说"
  { text: "我希望这个能快点", expect: false }, // 一次性请求,非持久偏好
  { text: "我以后会注意的", expect: false }, // 无具体可记事实
];

/** Reference answers for reporting. */
export const MEMORY_EVAL_EXPECTED: Record<string, boolean> = Object.fromEntries(
  MEMORY_EVAL_CASES.map((c, i) => [String(i), c.expect]),
);
