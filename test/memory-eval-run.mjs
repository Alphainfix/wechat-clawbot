/**
 * Run the memory-capture evaluation: classify every sample with
 * extractMemoryCandidates and report precision / recall / F1 vs expected.
 *
 * Usage: npm run test:memory
 * (The TS case file is compiled on the fly to a temp dir.)
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "memtest-"));
execSync(`npx tsc test/memory-eval-cases.ts --outDir ${tmp} --module nodenext --moduleResolution nodenext --target es2022`, { cwd: root, stdio: "pipe" });

const { extractMemoryCandidates } = await import(join(root, "lib/memory-auto.js"));
const { MEMORY_EVAL_CASES } = await import(join(tmp, "memory-eval-cases.js"));

let tp = 0, fp = 0, tn = 0, fn = 0;
const misses = [];
const falseAlarms = [];

for (const c of MEMORY_EVAL_CASES) {
  const captured = extractMemoryCandidates(c.text) === true;
  if (captured && c.expect) tp++;
  else if (captured && !c.expect) { fp++; falseAlarms.push(c.text); }
  else if (!captured && !c.expect) tn++;
  else { fn++; misses.push(c.text); }
}

const precision = tp / (tp + fp || 1);
const recall = tp / (tp + fn || 1);
const f1 = (2 * precision * recall) / (precision + recall || 1);

console.log("=== 记忆捕获评估结果 ===");
console.log(`样本总数: ${MEMORY_EVAL_CASES.length}`);
console.log(`正确捕获 (TP): ${tp}`);
console.log(`正确排除 (TN): ${tn}`);
console.log(`漏捕 (FN): ${fn}`);
console.log(`误捕 (FP): ${fp}`);
console.log(`精确率 (Precision): ${(precision * 100).toFixed(1)}%`);
console.log(`召回率 (Recall): ${(recall * 100).toFixed(1)}%`);
console.log(`F1: ${(f1 * 100).toFixed(1)}%`);
console.log("");
if (misses.length) { console.log("--- 漏捕样本 (应该记住但没记住) ---"); for (const m of misses) console.log(`  X ${m}`); }
if (falseAlarms.length) { console.log("--- 误捕样本 (不该记住但记住了) ---"); for (const m of falseAlarms) console.log(`  X ${m}`); }
