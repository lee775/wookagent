import { lazy, Suspense, type ComponentProps } from 'react';
import type { ActivityView, DirectiveView, TaskView } from '../../../shared/views';
import { useStudio3D } from '../lib/useStudio3D';
import { Office } from '../studio/Office';

const Studio3D = lazy(async () => ({ default: (await import('../studio3d/Studio3D')).Studio3D }));
const emptyTasks: TaskView[] = [];
const emptyDirectives: DirectiveView[] = [];
const emptyActivity: ActivityView[] = [];

export function OfficeScene({ tasks = emptyTasks, directives = emptyDirectives, activity = emptyActivity,
  emergency = false, ...props }: ComponentProps<typeof Office>) {
  return useStudio3D()
    ? <Suspense fallback={<div className="office-scene" />}><Studio3D {...props} tasks={tasks} directives={directives} activity={activity} emergency={emergency} /></Suspense>
    : <Office {...props} tasks={tasks} directives={directives} activity={activity} emergency={emergency} />;
}
