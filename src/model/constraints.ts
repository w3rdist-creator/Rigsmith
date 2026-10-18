// IK and path constraints adjust the sampled local pose before world transforms are
// built. Implemented in phase 2; with no constraints this is a no-op.
import type { Animation, LocalPose, Project } from './types.ts';

export function applyConstraints(project: Project, _pose: Map<string, LocalPose>, _anim: Animation | null, _time: number): void {
  if (!project.ik?.length && !project.pathConstraints?.length) return;
}
