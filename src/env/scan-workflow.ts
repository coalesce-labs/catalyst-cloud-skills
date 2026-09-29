// scan-workflow.ts — names a GitHub Actions workflow declares or references, read with the real YAML
// parser (`yaml`, D-2). A hand-written line scanner silently loses names written in flow style
// (`env: { A: 1, B: 2 }`); `parseDocument` does not, and it hands back the exact file:line for every
// key through `LineCounter`, plus the structural path (workflow env / a specific job) for free.
import { LineCounter, YAMLMap, YAMLSeq, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { RawSighting, WorkflowJob } from "./types.js";

const DEPLOY_JOB_ID_RE = /^(deploy|publish|release|cd)([-_].*)?$/i;
const DEPLOY_COMMANDS = ["wrangler deploy", "wrangler versions upload", "npm publish", "pnpm publish", "bun publish", "gh release create", "flyctl deploy", "vercel deploy"];
const SECRET_VAR_RE = /\$\{\{\s*(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface WorkflowScanResult {
  sightings: RawSighting[];
  jobs: WorkflowJob[];
}

export function scanWorkflow(file: string, text: string): WorkflowScanResult {
  const lc = new LineCounter();
  let doc;
  try {
    doc = parseDocument(text, { lineCounter: lc });
  } catch {
    return { sightings: [], jobs: [] };
  }
  const lineOf = (offset: number) => lc.linePos(offset).line;
  const root = doc.contents;
  const sightings: RawSighting[] = [];
  const jobs: WorkflowJob[] = [];
  const jobRanges: { id: string; start: number; end: number; deploy: boolean }[] = [];
  if (!isMap(root)) return { sightings, jobs };

  const topEnv = root.get("env", true);
  if (isMap(topEnv)) {
    for (const pair of (topEnv as YAMLMap).items) {
      if (!isScalar(pair.key)) continue;
      const offset = (pair.key.range?.[0] as number | undefined) ?? 0;
      sightings.push({
        name: String(pair.key.value),
        finding: { file, line: lineOf(offset), consumer: "workflow env", consumerKind: "workflow-env" },
        localSource: ".env file or your shell",
      });
    }
  }

  const jobsNode = root.get("jobs", true);
  if (isMap(jobsNode)) {
    for (const jobPair of (jobsNode as YAMLMap).items) {
      if (!isScalar(jobPair.key) || !isMap(jobPair.value)) continue;
      const jobId = String(jobPair.key.value);
      const jobMap = jobPair.value as YAMLMap;
      const jobKeyOffset = (jobPair.key.range?.[0] as number | undefined) ?? 0;
      const jobRange = (jobMap.range as [number, number, number] | undefined) ?? [jobKeyOffset, jobKeyOffset, jobKeyOffset];

      let deploy = jobMap.get("environment", true) !== undefined;
      let why = deploy ? "has an environment:" : "";
      if (!deploy && DEPLOY_JOB_ID_RE.test(jobId)) {
        deploy = true;
        why = "job id matches a deploy pattern";
      }

      const steps = jobMap.get("steps", true);
      if (isSeq(steps)) {
        for (const step of (steps as YAMLSeq).items) {
          if (!isMap(step)) continue;
          const run = step.get("run", true);
          if (isScalar(run) && typeof run.value === "string") {
            const cmd = DEPLOY_COMMANDS.find((c) => (run.value as string).includes(c));
            if (cmd) {
              deploy = true;
              why = `a step runs ${cmd}`;
            }
          }
          const stepEnv = step.get("env", true);
          if (isMap(stepEnv)) {
            for (const pair of (stepEnv as YAMLMap).items) {
              if (!isScalar(pair.key)) continue;
              const offset = (pair.key.range?.[0] as number | undefined) ?? 0;
              sightings.push({
                name: String(pair.key.value),
                finding: { file, line: lineOf(offset), consumer: `workflow job ${jobId}`, consumerKind: "workflow-job-env" },
                jobId,
                localSource: ".env file or your shell",
              });
            }
          }
        }
      }

      const jobEnv = jobMap.get("env", true);
      if (isMap(jobEnv)) {
        for (const pair of (jobEnv as YAMLMap).items) {
          if (!isScalar(pair.key)) continue;
          const offset = (pair.key.range?.[0] as number | undefined) ?? 0;
          sightings.push({
            name: String(pair.key.value),
            finding: { file, line: lineOf(offset), consumer: `workflow job ${jobId}`, consumerKind: "workflow-job-env" },
            jobId,
            localSource: ".env file or your shell",
          });
        }
      }

      jobs.push({ id: jobId, file, line: lineOf(jobKeyOffset), deploy, why: why || "no deploy signal" });
      jobRanges.push({ id: jobId, start: jobRange[0], end: jobRange[2] ?? jobRange[1], deploy });
    }
  }

  // ${{ secrets.X }} / ${{ vars.X }} references, over the RAW TEXT rather than the parsed tree: GitHub
  // Actions interpolates these anywhere, including inside a `run: |` block's shell text, and a plain
  // shell assignment inside that same block (e.g. `NOT_A_NAME=1`) must NOT be mined as a name — the
  // raw-text regex only ever matches the `${{ … }}` expression syntax, never bare shell.
  SECRET_VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECRET_VAR_RE.exec(text))) {
    const name = m[2]!;
    const offset = m.index;
    const job = jobRanges.find((j) => offset >= j.start && offset < j.end);
    sightings.push({
      name,
      finding: { file, line: lineOf(offset), consumer: job ? `workflow job ${job.id}` : "workflow", consumerKind: `${m[1]}-ref` },
      jobId: job?.id,
      jobDeploy: job?.deploy,
      localSource: "CI secret",
    });
  }
  for (const s of sightings) {
    if (s.jobId !== undefined && s.jobDeploy === undefined) s.jobDeploy = jobRanges.find((j) => j.id === s.jobId)?.deploy;
  }

  return { sightings, jobs };
}
