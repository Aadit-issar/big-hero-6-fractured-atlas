import { mkdirSync, writeFileSync } from 'node:fs';
import { MissionReplay, missionChapter } from '../src/atlas/lab/missionReplay';

const replay = new MissionReplay();
const checkpoints = [0, 2, 5, 8, 10.5, 16, 17.25, 22.25, 22.5, 23, 26, 28].map(time => {
  const view = replay.seek(time);
  const fold = view.temporal.folds[0];
  return {
    time, chapter: missionChapter(time), observation: view.observation,
    memory: view.mapping.summary, foldMemory: view.mapping.folds[0] ?? null,
    endpointAnalysis: fold?.entry ?? null,
    recordedStateChanges: view.events.filter(e => e.kind === 'fold-state-changed'),
    latestPublishedEvaluation: [...view.temporal.evaluations].reverse().find(e => e.published && e.key === fold?.entry.key && e.issuedAt >= 16) ?? null,
    recentArchivedPublishedPositions: replay.readPublished().slice(-3),
  };
});
mkdirSync('docs/atlas-evidence/holographic-mission', { recursive: true });
writeFileSync('docs/atlas-evidence/holographic-mission/runtime-checkpoints.json', JSON.stringify({ provenance: 'Authored simulated observations, actual AtlasRuntime outputs; no hidden simulator access', checkpoints }, null, 2));
console.log(`Wrote ${checkpoints.length} runtime evidence checkpoints.`);
